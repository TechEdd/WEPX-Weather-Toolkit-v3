import download
import convert
import stream_encoder
from datetime import datetime, timezone
import os
import re

CONFIG_DIR = "../configs/models"
CONTACT_EMAIL = "eddiepelletier.2006@gmail.com"
MAX_WAIT_MINUTES = 50

current_time = datetime.now(timezone.utc)
models = download.load_all_models(CONFIG_DIR, CONTACT_EMAIL)

task = None
for model in models:
    status, cycle_time = model.check_download_status(current_time, MAX_WAIT_MINUTES)
    if status == "READY":
        task = model.create_task(cycle_time)
        print(f"Starting Task for {model.id} cycle {cycle_time}")
    else:
        print(f"{model.id}: {status}")

# Dictionary to store the ongoing state for each stream
# Key: stream_id (e.g. 'TMP_2-AGL')
variable_streams = {}

# Set the base directory for all outputs
OUTPUT_BASE_DIR = "../../frontend/data/" + model.id
os.makedirs(OUTPUT_BASE_DIR, exist_ok=True)

if task:
    I_FRAME_INTERVAL = 8 

    # Iterate through downloaded files (now likely one per forecast hour containing multiple vars)
    for i in range(len(task.urls)):
        
        # 1. Download
        filepath = download.download_url(task.urls[i])
        if not filepath:
            continue
            
        # 2. Process GRIB (Extract all requested variables from this single file)
        width = convert.get_best_width_for_epsg4326(filepath)
        
        # This returns a list of results found in the file
        stream_results = convert.process_multi_band_grib(
            filepath, 
            width, 
            task.variables_config, 
            model=task.model_id
        )
        
        if not stream_results:
            print(f"Warning: No matching variables found in {filepath}")
            continue
            
        # 3. Iterate through extracted streams
        for result in stream_results:
            STREAM_ID = result['stream_id']
            data_array = result['data']
            RUN_EPOCH_FOLDER_NAME = result['ref_time'] # From GRIB_REF_TIME
            VALID_TIME = result['valid_time']          # From GRIB_VALID_TIME
            
            # Create target folder: forecast_streams/{unix_ref_time}
            TARGET_DIR = os.path.join(OUTPUT_BASE_DIR, RUN_EPOCH_FOLDER_NAME)
            os.makedirs(TARGET_DIR, exist_ok=True)
            
            FULL_STREAM_NAME = os.path.join(TARGET_DIR, STREAM_ID)
            
            # --- Stream Encoding ---
            
            # Prepare extra metadata for this frame
            frame_metadata = {
                'valid_time': VALID_TIME
            }
            
            if STREAM_ID not in variable_streams:
                # --- Initialize New Stream (Frame 0) ---
                print(f"\n--- INITIALIZING: {STREAM_ID} (Ref: {RUN_EPOCH_FOLDER_NAME}) ---")
                
                # Pass frame_metadata to renderImage. 
                # Assuming renderImage accepts an optional dict or we merge it.
                # If stream_encoder doesn't support extra args, you might need to adapt this line.
                # Here passing it as a separate argument if supported, or relying on user's impl.
                metadata = stream_encoder.renderImage(data_array, FULL_STREAM_NAME, extra_meta=frame_metadata)
                
                variable_streams[STREAM_ID] = {
                    'metadata': metadata,
                    'last_array': data_array,
                    'frame_count': 0
                }
                
            else:
                # --- Append to Existing Stream ---
                state = variable_streams[STREAM_ID]
                last_array = state['last_array']
                metadata = state['metadata']
                current_frame_count = state['frame_count'] + 1
                
                if current_frame_count % I_FRAME_INTERVAL == 0:
                    print(f"--- I-FRAME: {STREAM_ID} (Frame {current_frame_count}) ---")
                    stream_encoder.appendIFrame(data_array, FULL_STREAM_NAME, metadata, extra_meta=frame_metadata)
                else:
                    print(f"--- P-FRAME: {STREAM_ID} (Frame {current_frame_count}) ---")
                    stream_encoder.appendImage(last_array, data_array, FULL_STREAM_NAME, metadata, extra_meta=frame_metadata)
                
                variable_streams[STREAM_ID]['last_array'] = data_array
                variable_streams[STREAM_ID]['frame_count'] = current_frame_count

    print("\nStream generation complete.")
