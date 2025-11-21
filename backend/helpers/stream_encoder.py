import numpy as np
from PIL import Image
import gzip
import struct
import os
import io # Added missing import

# --- Constants ---
TYPE_I_FRAME = 0x00
TYPE_P_FRAME = 0x01
HEADER_STRUCT = '<IB' # Little-endian uint32 (Length), uint8 (Type)

# --- Helper: Metadata Encoding (Float -> RGB) ---
def encode_float_to_rgb(val):
    bits = np.array([val], dtype=np.float32).view(np.uint32)[0]
    sign = (bits >> 31) & 0x1
    raw_exp = (bits >> 23) & 0xFF
    new_exp = np.clip(int(raw_exp) - 64, 0, 127)
    mantissa = (bits >> 7) & 0xFFFF
    return ((sign << 7) | new_exp), ((mantissa >> 8) & 0xFF), (mantissa & 0xFF)

# --- Helper: Layer Splitting ---
def get_layers(data, metadata):
    """Splits float data into Base (8-bit) and Residual (16-bit)."""
    MIN, RANGE, RES_MIN, RES_RANGE = metadata
    
    # 1. Base Layer (8-bit)
    norm_base = (data - MIN) / RANGE
    base_8bit = np.clip(norm_base * 255, 0, 255).astype(np.uint8)
    
    # 2. Residual Layer (16-bit)
    recovered_base = (base_8bit.astype(np.float32) / 255.0) * RANGE + MIN
    diff = data - recovered_base
    
    norm_diff = np.clip((diff - RES_MIN) / RES_RANGE, 0, 1)
    res_16bit = np.clip(norm_diff * 65535, 0, 65535).astype(np.uint16)
    
    return base_8bit, res_16bit

def write_chunk(f, data_bytes, frame_type):
    """Writes [Length][Type][Data] to file."""
    header = struct.pack(HEADER_STRUCT, len(data_bytes), frame_type)
    f.write(header)
    f.write(data_bytes)

# --- Main Functions ---

def renderImage(array, filename_base):
    """
    Starts a new stream (Frame 0). Generates I-Frames for Base and Detail.
    Calculates and embeds metadata. Overwrites existing files.
    """
    # 1. Calculate Metadata (Global for the stream based on first frame)
    try:
        GLOBAL_MIN = float(np.nanmin(array))
        GLOBAL_MAX = float(np.nanmax(array))
    except ValueError:
        # If the array is entirely NaNs or empty, set a safe range
        GLOBAL_MIN = 0.0
        GLOBAL_MAX = 1.0
        
    GLOBAL_RANGE = GLOBAL_MAX - GLOBAL_MIN if GLOBAL_MAX != GLOBAL_MIN else 1.0
    
    RESIDUAL_RANGE = GLOBAL_RANGE / 128.0
    RESIDUAL_MIN = -RESIDUAL_RANGE / 2.0
    
    metadata = (GLOBAL_MIN, GLOBAL_RANGE, RESIDUAL_MIN, RESIDUAL_RANGE)
    print(metadata)
    
    # 2. Get Layers
    base_8bit, res_16bit = get_layers(array, metadata)
    
    # 3. Create Base I-Frame (WebP)
    base_img = np.stack([base_8bit]*3, axis=-1)
    
    # Embed Metadata
    base_img[0, 0] = encode_float_to_rgb(GLOBAL_MIN)
    base_img[0, 1] = encode_float_to_rgb(GLOBAL_RANGE)
    base_img[0, 2] = encode_float_to_rgb(RESIDUAL_MIN)
    base_img[0, 3] = encode_float_to_rgb(RESIDUAL_RANGE)
    
    buf_base = io.BytesIO()
    Image.fromarray(base_img).save(buf_base, format='WEBP', lossless=True)
    
    # 4. Create Detail I-Frame (WebP)
    r_res = (res_16bit >> 8).astype(np.uint8)
    g_res = (res_16bit & 0xFF).astype(np.uint8)
    b_res = np.zeros_like(r_res)
    detail_img = np.stack([r_res, g_res, b_res], axis=-1)
    
    buf_detail = io.BytesIO()
    Image.fromarray(detail_img).save(buf_detail, format='WEBP', lossless=True)
    
    # 5. Write to Streams (Write Mode 'wb')
    with open(f"{filename_base}_base.timeseries", "wb") as fb:
        write_chunk(fb, buf_base.getvalue(), TYPE_I_FRAME)
        
    with open(f"{filename_base}_detail.timeseries", "wb") as fd:
        write_chunk(fd, buf_detail.getvalue(), TYPE_I_FRAME)
        
    return metadata

def appendIFrame(array, filename_base, metadata):
    """
    Appends a periodic I-Frame (WebP) to existing streams.
    Uses 'ab' (append) mode.
    """
    MIN, RANGE, RES_MIN, RES_RANGE = metadata
    
    # 1. Get Layers
    base_8bit, res_16bit = get_layers(array, metadata)
    
    # 2. Create Base I-Frame (WebP)
    base_img = np.stack([base_8bit]*3, axis=-1)
    
    # Embed Metadata (Keep consistent with frame 0)
    base_img[0, 0] = encode_float_to_rgb(MIN)
    base_img[0, 1] = encode_float_to_rgb(RANGE)
    base_img[0, 2] = encode_float_to_rgb(RES_MIN)
    base_img[0, 3] = encode_float_to_rgb(RES_RANGE)
    
    buf_base = io.BytesIO()
    Image.fromarray(base_img).save(buf_base, format='WEBP', lossless=True)
    
    # 3. Create Detail I-Frame (WebP)
    r_res = (res_16bit >> 8).astype(np.uint8)
    g_res = (res_16bit & 0xFF).astype(np.uint8)
    b_res = np.zeros_like(r_res)
    detail_img = np.stack([r_res, g_res, b_res], axis=-1)
    
    buf_detail = io.BytesIO()
    Image.fromarray(detail_img).save(buf_detail, format='WEBP', lossless=True)
    
    # 4. Write to Streams (Append Mode 'ab')
    with open(f"{filename_base}_base.timeseries", "ab") as fb:
        write_chunk(fb, buf_base.getvalue(), TYPE_I_FRAME)
        
    with open(f"{filename_base}_detail.timeseries", "ab") as fd:
        write_chunk(fd, buf_detail.getvalue(), TYPE_I_FRAME)

def appendImage(lastArray, currentArray, filename_base, metadata):
    """
    Appends a P-Frame (Gzip Delta) to the streams.
    """
    # 1. Get Layers
    last_base, last_res = get_layers(lastArray, metadata)
    curr_base, curr_res = get_layers(currentArray, metadata)
    
    # 2. Calculate Deltas
    delta_base = curr_base.astype(np.int16) - last_base.astype(np.int16)
    delta_res = curr_res.astype(np.int32) - last_res.astype(np.int32)
    
    # 3. Compress (Gzip)
    gz_base = gzip.compress(delta_base.tobytes())
    gz_res = gzip.compress(delta_res.tobytes())
    
    # 4. Append to Streams
    with open(f"{filename_base}_base.timeseries", "ab") as fb:
        write_chunk(fb, gz_base, TYPE_P_FRAME)
        
    with open(f"{filename_base}_detail.timeseries", "ab") as fd:
        write_chunk(fd, gz_res, TYPE_P_FRAME)