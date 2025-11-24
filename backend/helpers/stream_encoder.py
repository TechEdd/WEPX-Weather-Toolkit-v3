import numpy as np
from PIL import Image
import os
import struct
import gzip

# --- Constants ---
TYPE_I_FRAME = 0x00
TYPE_P_FRAME = 0x01
HEADER_STRUCT = '<IB' # Little-endian uint32 (Length), uint8 (Type)

def encode_meta_float(value):
    """
    Encodes a float32 into 3 bytes (24 bits) of RGB.
    Format: [Sign(1) | Exponent(7)] [Mantissa(8)] [Mantissa(8)]
    Returns a tuple (r, g, b)
    """
    # Pack to standard IEEE 754 32-bit float
    packed = struct.pack('f', float(value))
    i = struct.unpack('I', packed)[0]
    
    s = (i >> 31) & 0x1
    e = (i >> 23) & 0xFF
    m = i & 0x7FFFFF
    
    # Compress Exponent (8-bit -> 7-bit)
    # Bias is 127. We map 127 -> 63. Range roughly 10^-19 to 10^19
    e_7bit = max(0, min(127, e - 64))
    
    # Compress Mantissa (23-bit -> 16-bit)
    m_16bit = m >> 7
    
    # Pack into RGB
    r = (s << 7) | e_7bit
    g = (m_16bit >> 8) & 0xFF
    b = m_16bit & 0xFF
    
    return (r, g, b)

def prepare_payload(data_bytes, extra_meta):
    """
    Prepends the 4-byte Valid Time timestamp to the raw data payload.
    """
    valid_time = 0
    if extra_meta and 'valid_time' in extra_meta:
        try:
            valid_time = int(extra_meta['valid_time'])
        except ValueError:
            print(f"Warning: Invalid valid_time format: {extra_meta['valid_time']}")
            valid_time = 0
            
    # Pack Valid Time as Little-Endian Unsigned Int (4 bytes)
    time_header = struct.pack('<I', valid_time)
    return time_header + data_bytes

def write_chunk(f, frame_type, payload):
    """
    Writes [Length][Type][Payload] to the file stream.
    """
    length = len(payload)
    header = struct.pack(HEADER_STRUCT, length, frame_type)
    f.write(header)
    f.write(payload)

def renderImage(data_array, filepath, extra_meta=None):
    """
    Initializes a new stream with the first Frame (I-Frame).
    Calculates global min/max/range to freeze the quantization factors.
    """
    base_filename = filepath + "_base.timeseries"
    detail_filename = filepath + "_detail.timeseries"
    
    # --- 1. Analyze Data Statistics (Global Metadata) ---
    # We use these stats to normalize ALL future frames in this stream
    valid_data = data_array[~np.isnan(data_array)]
    if len(valid_data) == 0:
        MIN, MAX = 0.0, 1.0
    else:
        MIN = float(np.min(valid_data))
        MAX = float(np.max(valid_data))
        
    RANGE = MAX - MIN
    if RANGE == 0: RANGE = 1.0
    
    # Heuristic: Base layer gets 8-bit precision, Residual gets 16-bit
    # We define RES_RANGE loosely based on expected variance
    RES_RANGE = RANGE * 0.2 # Assume residuals are smaller
    RES_MIN = -RES_RANGE / 2
    
    metadata = {
        'MIN': MIN, 'RANGE': RANGE,
        'RES_MIN': RES_MIN, 'RES_RANGE': RES_RANGE,
        'WIDTH': data_array.shape[1],
        'HEIGHT': data_array.shape[0]
    }

    # Delete existing files if starting fresh
    if os.path.exists(base_filename): os.remove(base_filename)
    if os.path.exists(detail_filename): os.remove(detail_filename)

    # --- 2. Encode Frame 0 (I-Frame) ---
    appendIFrame(data_array, filepath, metadata, extra_meta)
    
    return metadata

def appendIFrame(data_array, filepath, metadata, extra_meta=None):
    """
    Encodes a full frame as WebP (I-Frame) and appends to stream.
    Handles Transparency (Alpha) for NaN values.
    """
    # Create Alpha Mask: 0 where NaN, 255 where valid
    alpha_mask = np.where(np.isnan(data_array), 0, 255).astype(np.uint8)

    # Fill NaNs with MIN for encoding calculation
    data_array = np.nan_to_num(data_array, nan=metadata['MIN'])
    
    # --- Quantize Base Layer (8-bit) ---
    normalized = (data_array - metadata['MIN']) / metadata['RANGE']
    base_layer = np.clip(normalized * 255, 0, 255).astype(np.uint8)
    
    # --- Quantize Residual (16-bit) ---
    # Reconstruct what the base layer represents to find the error
    reconstructed_base = base_layer.astype(np.float32) / 255.0 * metadata['RANGE'] + metadata['MIN']
    residual_float = data_array - reconstructed_base
    
    norm_res = (residual_float - metadata['RES_MIN']) / metadata['RES_RANGE']
    res_layer = np.clip(norm_res * 65535, 0, 65535).astype(np.uint16)
    
    # --- Pack into Images ---
    
    # Base Image: RGBA (R=Base, G=Base, B=Base, A=Mask)
    # We encode metadata into the first 4 pixels of the Base Image
    # We MUST ensure the metadata pixels are fully opaque (A=255)
    base_img_array = np.dstack((base_layer, base_layer, base_layer, alpha_mask))
    
    # Inject Metadata into pixels (0,0) to (0,3)
    if 'MIN' in metadata:
        meta_pixels = [
            encode_meta_float(metadata['MIN']),
            encode_meta_float(metadata['RANGE']),
            encode_meta_float(metadata['RES_MIN']),
            encode_meta_float(metadata['RES_RANGE'])
        ]
        for i, (r, g, b) in enumerate(meta_pixels):
            # Set RGB + Alpha=255 for metadata pixels
            base_img_array[0, i] = [r, g, b, 255]

    # Detail Image: R=ResHigh, G=ResLow, B=0
    # Detail image doesn't strictly need alpha as it's just data containers,
    # but we keep it RGB for simplicity.
    r_channel = (res_layer >> 8).astype(np.uint8)
    g_channel = (res_layer & 0xFF).astype(np.uint8)
    b_channel = np.zeros_like(r_channel)
    detail_img_array = np.dstack((r_channel, g_channel, b_channel))
    
    # --- Save to WebP Bytes ---
    # Base (RGBA)
    img_base = Image.fromarray(base_img_array, 'RGBA')
    import io
    buf_base = io.BytesIO()
    img_base.save(buf_base, format='WEBP', quality=100, lossless=True)
    bytes_base = buf_base.getvalue()
    
    # Detail (RGB)
    img_detail = Image.fromarray(detail_img_array, 'RGB')
    buf_detail = io.BytesIO()
    img_detail.save(buf_detail, format='WEBP', quality=100, lossless=True)
    bytes_detail = buf_detail.getvalue()

    # --- Prep Payloads with Time ---
    payload_base = prepare_payload(bytes_base, extra_meta)
    payload_detail = prepare_payload(bytes_detail, extra_meta)

    # --- Append to Files ---
    with open(filepath + "_base.timeseries", "ab") as f:
        write_chunk(f, TYPE_I_FRAME, payload_base)
        
    with open(filepath + "_detail.timeseries", "ab") as f:
        write_chunk(f, TYPE_I_FRAME, payload_detail)


def appendImage(prev_array, curr_array, filepath, metadata, extra_meta=None):
    """
    Calculates delta from previous array, compresses with Gzip (P-Frame), and appends.
    NOTE: P-Frames currently do not update the Alpha Mask. 
    They assume the transparency mask (NoData area) is static from the I-Frame.
    """
    curr_array = np.nan_to_num(curr_array, nan=metadata['MIN'])
    prev_array = np.nan_to_num(prev_array, nan=metadata['MIN'])
    
    # --- 1. Quantize Current Frame ---
    # Base
    norm_curr = (curr_array - metadata['MIN']) / metadata['RANGE']
    base_curr = np.clip(norm_curr * 255, 0, 255).astype(np.uint8)
    
    # Residual
    recon_base = base_curr.astype(np.float32) / 255.0 * metadata['RANGE'] + metadata['MIN']
    res_float = curr_array - recon_base
    norm_res = (res_float - metadata['RES_MIN']) / metadata['RES_RANGE']
    res_curr = np.clip(norm_res * 65535, 0, 65535).astype(np.uint16)
    
    # --- 2. Quantize Previous Frame (re-calculate to ensure exact sync with decoder state) ---
    norm_prev = (prev_array - metadata['MIN']) / metadata['RANGE']
    base_prev = np.clip(norm_prev * 255, 0, 255).astype(np.uint8)
    
    recon_base_prev = base_prev.astype(np.float32) / 255.0 * metadata['RANGE'] + metadata['MIN']
    res_float_prev = prev_array - recon_base_prev
    norm_res_prev = (res_float_prev - metadata['RES_MIN']) / metadata['RES_RANGE']
    res_prev = np.clip(norm_res_prev * 65535, 0, 65535).astype(np.uint16)
    
    # --- 3. Calculate Deltas ---
    # Base Delta (int16 to safely hold -255 to 255)
    delta_base = base_curr.astype(np.int16) - base_prev.astype(np.int16)
    
    # Residual Delta (int32 to safely hold -65535 to 65535)
    delta_res = res_curr.astype(np.int32) - res_prev.astype(np.int32)
    
    # --- 4. Compress ---
    bytes_base = gzip.compress(delta_base.tobytes())
    bytes_detail = gzip.compress(delta_res.tobytes())

    # --- 5. Prep Payloads with Time ---
    payload_base = prepare_payload(bytes_base, extra_meta)
    payload_detail = prepare_payload(bytes_detail, extra_meta)
    
    # --- 6. Write ---
    with open(filepath + "_base.timeseries", "ab") as f:
        write_chunk(f, TYPE_P_FRAME, payload_base)
        
    with open(filepath + "_detail.timeseries", "ab") as f:
        write_chunk(f, TYPE_P_FRAME, payload_detail)