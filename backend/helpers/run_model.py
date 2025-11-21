import download
import convert
import stream_encoder
from datetime import datetime,timezone
import os
import re
CONFIG_DIR = "../configs/models"
CONTACT_EMAIL = "eddiepelletier.2006@gmail.com"
MAX_WAIT_MINUTES = 30

current_time = datetime.now(timezone.utc)
models = download.load_all_models(CONFIG_DIR, CONTACT_EMAIL)

task=None
for model in models:
    status, cycle_time = model.check_download_status(current_time, MAX_WAIT_MINUTES)
    if (status == "READY"):
        task = model.create_task(cycle_time)
    else:
        print(status)

filepath = None
metadata = None
last_data_array = None

def extract_metadata_from_filepath(filepath):
    """
    Extracts the unique stream identifier (Variable_Level) and the Run Epoch (Unix Timestamp)
    from the complex GRIB filepath/URL structure.
    
    The Run Epoch is calculated from the Initial Run Time (YYYYMMDD + tXXz) found in the path.
    """
    
    # 1. Extract Run Epoch (Unix Timestamp of the Forecast Start)
    
    # Search for YYYYMMDD (8 digits)
    date_match = re.search(r'(\d{8})', filepath)
    
    # Search for Run Hour (tXXz or just tXX)
    run_hour_match = re.search(r'[tT](\d{2})[zZ]', filepath)
    
    if date_match and run_hour_match:
        date_str = date_match.group(1)
        hour_str = run_hour_match.group(1)
        
        try:
            # Parse YYYYMMDDHH into a naive datetime
            dt_naive = datetime.strptime(f"{date_str}{hour_str}", "%Y%m%d%H")
            # Enforce UTC timezone
            dt_utc = dt_naive.replace(tzinfo=timezone.utc)
            # Convert to integer Unix Timestamp (seconds)
            run_epoch_folder_name = str(int(dt_utc.timestamp()))
        except ValueError:
            # Fallback if parsing fails
            run_epoch_folder_name = str(int(datetime.now(timezone.utc).timestamp()))
    else:
        # Fallback uses current UTC timestamp if no date info found
        run_epoch_folder_name = str(int(datetime.now(timezone.utc).timestamp()))


    # 2. Extract Variable + Level (Unique Stream ID)
    filename = filepath.split(os.path.sep)[-1]
    
    var_match = re.search(r'var_([^=]+)=on', filename)
    lev_match = re.search(r'lev_([^=]+)=on', filename)

    if var_match and lev_match:
        variable = var_match.group(1)
        level = lev_match.group(1).replace('_', '-') 
        stream_id = f"{variable}_{level}"
    elif var_match:
        stream_id = var_match.group(1)
    else:
        stream_id = "unknown_variable"
    
    return stream_id, run_epoch_folder_name

# Dictionary to store the ongoing state for each stream (e.g., 'TMP_2-m-above-ground')
variable_streams = {}

# Set the base directory for all outputs
OUTPUT_BASE_DIR = "forecast_streams"
os.makedirs(OUTPUT_BASE_DIR, exist_ok=True)


if task:
    I_FRAME_INTERVAL = 8 

    for i in range(len(task.urls)):
        # 1. Download and Get Filepath
        filepath = download.download_url(task.urls[i])
        
        if not filepath:
            continue
            
        # 2. Get Metadata
        # RUN_EPOCH_FOLDER_NAME will now be something like "1763683200"
        STREAM_ID, RUN_EPOCH_FOLDER_NAME = extract_metadata_from_filepath(filepath)
        
        # 3. Create Target Output Folder (e.g., forecast_streams/1763683200)
        TARGET_DIR = os.path.join(OUTPUT_BASE_DIR, RUN_EPOCH_FOLDER_NAME)
        os.makedirs(TARGET_DIR, exist_ok=True)
        
        # The stream file name is the path: /target/dir/STREAM_ID
        FULL_STREAM_NAME = os.path.join(TARGET_DIR, STREAM_ID)
        
        # --- 4. Load Array and Check Data Integrity ---
        width = convert.get_best_width_for_epsg4326(filepath)
        data_array = convert.convert_GRIB_to_Array(filepath, width)
        
        if data_array is None:
            print(f"Warning: Conversion failed for {STREAM_ID} at {filepath}. Skipping.")
            continue
        
        # --- 5. Check and Initialize Stream State ---
        if STREAM_ID not in variable_streams:
            # First time we see this variable (Frame 0 for this stream)
            
            # Renders I-Frame (Frame 0) and sets initial metadata
            metadata = stream_encoder.renderImage(data_array, FULL_STREAM_NAME)
            
            print(f"\n--- INITIALIZED STREAM: {STREAM_ID} in folder {RUN_EPOCH_FOLDER_NAME} ---")
            
            # Store the state for this variable
            variable_streams[STREAM_ID] = {
                'metadata': metadata,
                'last_array': data_array,
                'frame_count': 0
            }
            
        # --- 6. Append to Existing Stream ---
        else:
            # Subsequent frame for an existing stream
            
            state = variable_streams[STREAM_ID]
            last_array = state['last_array']
            metadata = state['metadata']
            current_frame_count = state['frame_count'] + 1
            
            # Check for Periodic I-Frame
            if current_frame_count % I_FRAME_INTERVAL == 0:
                print(f"--- APPENDED I-FRAME to STREAM: {STREAM_ID} (Frame {current_frame_count}) ---")
                stream_encoder.appendIFrame(data_array, FULL_STREAM_NAME, metadata)
            else:
                # Append P-Frame Delta
                print(f"--- APPENDED P-FRAME to STREAM: {STREAM_ID} (Frame {current_frame_count}) ---")
                stream_encoder.appendImage(last_array, data_array, FULL_STREAM_NAME, metadata)
            
            # Update the state
            variable_streams[STREAM_ID]['last_array'] = data_array
            variable_streams[STREAM_ID]['frame_count'] = current_frame_count
            
# --- Final Output ---
print("\nStream generation complete.")
print(f"Generated streams saved under the '{OUTPUT_BASE_DIR}' directory.")
