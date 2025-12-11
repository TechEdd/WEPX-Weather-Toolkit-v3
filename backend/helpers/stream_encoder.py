import numpy as np
import zlib
import struct
import json
import os
import math

# --- Constants ---
TYPE_I_FRAME = 0x00
TYPE_P_FRAME = 0x01
HEADER_STRUCT = '<IB' 
ZLIB_LEVEL = 8     

# Updated function for stream_encoder.py

def calculate_dynamic_scale(data_array):
    """
    Dynamically determines the decimal scaling factor based on the data range (Max - Min).
    Uses a fixed-bucket system for deterministic precision control.
    """
    valid_data = data_array[~np.isnan(data_array)]
    
    # Fallback for empty/NaN-only arrays
    if len(valid_data) == 0:
        return 100.0 

    d_min = float(np.min(valid_data))
    d_max = float(np.max(valid_data))
    d_range = d_max - d_min

    # --- Handle Edge Case (Flat Field) ---
    if d_range == 0:
        # If the range is zero (e.g., all 0mm rain), use high precision 
        # just in case tiny values appear later, or if the single value needs precision.
        return 10000.0 

    # --- Fixed Bucket Logic ---
    if d_range > 200.0:
        # e.g., CAPE (0 - 4000) -> 0 decimals
        return 1.0
    elif d_range > 15.0:
        # e.g., Temperature (40 - 100) -> 1 decimal
        return 10.0
    elif d_range > 5.0:
        # e.g., Temperature (20 - 40) -> 2 decimals
        return 100.0
    else: # d_range <= 10.0
        # e.g., PRATE (0 - 0.5) or small temperature changes -> 4 decimals
        return 10000.0

def process_transparency(data_array):
    valid_mask = ~np.isnan(data_array)
    if np.all(valid_mask):
        return np.nan_to_num(data_array), None, False

    packed_mask = np.packbits(valid_mask.flatten().astype(np.uint8))
    
    flat_data = data_array.flatten()
    mask = np.isnan(flat_data)
    idx = np.where(~mask, np.arange(mask.shape[0]), 0)
    np.maximum.accumulate(idx, out=idx, axis=0)
    filled_data = flat_data[idx]
    
    clean_data = filled_data.reshape(data_array.shape)
    clean_data = np.nan_to_num(clean_data, nan=0.0)

    return clean_data, packed_mask.tobytes(), True

def quantize(data_array, scale):
    return np.round(data_array * scale).astype(np.int32)

def spatial_diff_encode(int_array):
    diff = int_array.copy()
    diff[:, 1:] -= diff[:, :-1]
    return diff

def prepare_payload(zlib_bytes, extra_meta, stream_meta=None):
    valid_time = 0
    if extra_meta and 'valid_time' in extra_meta:
        try:
            valid_time = int(extra_meta['valid_time'])
        except ValueError:
            pass
    time_header = struct.pack('<I', valid_time)

    meta_bytes = b''
    if stream_meta:
        meta_json = json.dumps(stream_meta).encode('utf-8')
        meta_len = len(meta_json)
        meta_bytes = struct.pack('<H', meta_len) + meta_json
    else:
        meta_bytes = struct.pack('<H', 0)

    return time_header + meta_bytes + zlib_bytes

def write_chunk(f, frame_type, payload):
    length = len(payload)
    header = struct.pack(HEADER_STRUCT, length, frame_type)
    f.write(header)
    f.write(payload)

# --- Main Functions ---

def renderImage(data_array, filepath, extent=None, extra_meta=None):
    """
    Calculates scale automatically, encodes I-Frame, and saves metadata.
    """
    filename = filepath + ".wepx"
    if os.path.exists(filename): 
        os.remove(filename)

    # 1. Calculate Dynamic Scale
    scale = calculate_dynamic_scale(data_array)

    # 2. Stats for Meta
    valid_data = data_array[~np.isnan(data_array)]
    if len(valid_data) > 0:
        min_val = float(np.min(valid_data))
        max_val = float(np.max(valid_data))
    else:
        min_val, max_val = 0.0, 0.0

    clean_data, mask_bytes, has_alpha = process_transparency(data_array)

    metadata = {
        'min': min_val,
        'max': max_val,
        'width': data_array.shape[1],
        'height': data_array.shape[0],
        'scale': scale, # Store the calculated scale!
        'alpha': has_alpha
    }
    if extent:
        metadata['extent'] = extent

    q_curr = quantize(clean_data, scale)
    s_diff = spatial_diff_encode(q_curr)
    
    raw_payload = s_diff.tobytes()
    if has_alpha:
        raw_payload = mask_bytes + raw_payload

    z_bytes = zlib.compress(raw_payload, level=ZLIB_LEVEL)

    payload = prepare_payload(z_bytes, extra_meta, stream_meta=metadata)
    with open(filename, "ab") as f:
        write_chunk(f, TYPE_I_FRAME, payload)
    
    return metadata

def appendIFrame(data_array, filepath, metadata, extra_meta=None):
    filename = filepath + ".wepx"
    
    # Reuse the scale calculated in the first frame
    scale = metadata.get('scale', 100.0)

    clean_data, mask_bytes, has_alpha = process_transparency(data_array)
    q_curr = quantize(clean_data, scale)
    s_diff = spatial_diff_encode(q_curr)
    
    raw_payload = s_diff.tobytes()
    if has_alpha:
        raw_payload = mask_bytes + raw_payload
        
    z_bytes = zlib.compress(raw_payload, level=ZLIB_LEVEL)
    
    payload = prepare_payload(z_bytes, extra_meta, stream_meta=metadata)
    with open(filename, "ab") as f:
        write_chunk(f, TYPE_I_FRAME, payload)

def appendImage(prev_array, curr_array, filepath, metadata, extra_meta=None):
    filename = filepath + ".wepx"
    
    scale = metadata.get('scale', 100.0)

    clean_curr, mask_bytes, has_alpha = process_transparency(curr_array)
    clean_prev, _, _ = process_transparency(prev_array)

    q_curr = quantize(clean_curr, scale)
    q_prev = quantize(clean_prev, scale)

    t_diff = q_curr - q_prev
    s_t_diff = spatial_diff_encode(t_diff)

    raw_payload = s_t_diff.tobytes()
    if has_alpha:
        raw_payload = mask_bytes + raw_payload

    z_bytes = zlib.compress(raw_payload, level=ZLIB_LEVEL)

    payload = prepare_payload(z_bytes, extra_meta, stream_meta=None)
    with open(filename, "ab") as f:
        write_chunk(f, TYPE_P_FRAME, payload)