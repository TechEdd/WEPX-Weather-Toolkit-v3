import download
import convert
import stream_encoder
from datetime import datetime, timezone
import os
import sys
import shutil
import time
from concurrent.futures import ProcessPoolExecutor

CONFIG_DIR = "../configs/models"
CONTACT_EMAIL = "eddiepelletier.2006@gmail.com"
MAX_WAIT_MINUTES = 40
# Define a general directory for locks to avoid collision
LOCK_DIR = "./locks" 

def process_single_model(model_obj, cycle_time):
    """
    Worker function to handle the full lifecycle of a single model run.
    This runs inside a separate process.
    """
    
    # --- 1. LOCKING MECHANISM ---
    # Create a unique lock file name for this specific model run
    # e.g., ./locks/HRRR_20231027_12.lock
    os.makedirs(LOCK_DIR, exist_ok=True)
    lock_filename = f"{model_obj.id}_{cycle_time.strftime('%Y%m%d_%H')}.lock"
    lock_filepath = os.path.join(LOCK_DIR, lock_filename)

    if os.path.exists(lock_filepath):
        print(f"[SKIP] {model_obj.id} cycle {cycle_time} is already being processed (Lock file exists).")
        return

    # Create the lock file
    try:
        with open(lock_filepath, 'w') as f:
            f.write(str(datetime.now()))
    except Exception as e:
        print(f"Error creating lock file for {model_obj.id}: {e}")
        return

    print(f"[START] Starting Task for {model_obj.id} cycle {cycle_time}")

    try:
        # --- 2. INITIALIZATION ---
        task = model_obj.create_task(cycle_time)
        
        # Local state for this process (critical for parallel execution)
        variable_streams = {}
        
        # Set output directory
        OUTPUT_BASE_DIR = "../../frontend/data/" + model_obj.id
        os.makedirs(OUTPUT_BASE_DIR, exist_ok=True)
        
        I_FRAME_INTERVAL = 8 

        if not task:
            print(f"Error: Could not create task for {model_obj.id}")
            return

        # --- 3. PROCESSING LOOP ---
        for i in range(len(task.urls)):
            
            # Download
            filepath = download.download_url(task.urls[i])
            if not filepath:
                continue
            
            # Process GRIB
            # Note: Ensure convert.get_best_width... is thread/process safe (usually is if just reading)
            width = convert.get_best_width_for_epsg4326(filepath)
            
            stream_results = convert.process_multi_band_grib(
                filepath, 
                width, 
                task.variables_config, 
                model=task.model_id
            )
            
            if not stream_results:
                print(f"Warning: No matching variables found in {filepath}")
                continue
                
            # Iterate through extracted streams
            for result in stream_results:
                STREAM_ID = result['stream_id']
                data_array = result['data']
                RUN_EPOCH_FOLDER_NAME = result['ref_time']
                VALID_TIME = result['valid_time']
                EXTENT = result['extent']
                
                TARGET_DIR = os.path.join(OUTPUT_BASE_DIR, RUN_EPOCH_FOLDER_NAME)
                os.makedirs(TARGET_DIR, exist_ok=True)
                
                FULL_STREAM_NAME = os.path.join(TARGET_DIR, STREAM_ID)
                
                # Metadata for this frame
                frame_metadata = {
                    'valid_time': VALID_TIME
                }
                
                if STREAM_ID not in variable_streams:
                    # --- Initialize New Stream (Frame 0) ---
                    # print(f"--- INIT: {model_obj.id} / {STREAM_ID} ---")
                    
                    metadata = stream_encoder.renderImage(data_array, FULL_STREAM_NAME, extent=EXTENT, extra_meta=frame_metadata)
                    
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
                        stream_encoder.appendIFrame(data_array, FULL_STREAM_NAME, metadata, extra_meta=frame_metadata)
                    else:
                        stream_encoder.appendImage(last_array, data_array, FULL_STREAM_NAME, metadata, extra_meta=frame_metadata)
                    
                    variable_streams[STREAM_ID]['last_array'] = data_array
                    variable_streams[STREAM_ID]['frame_count'] = current_frame_count

        print(f"[DONE] Stream generation complete for {model_obj.id}.")

    except Exception as e:
        print(f"[ERROR] Processing failed for {model_obj.id}: {e}")
        # Optional: You might want to leave the lock file here if you want to inspect why it failed,
        # otherwise, let the finally block clean it up so it retries next time.
        
    finally:
        # --- 4. CLEANUP LOCK ---
        if os.path.exists(lock_filepath):
            os.remove(lock_filepath)


def main():
    current_time = datetime.now(timezone.utc)
    models = download.load_all_models(CONFIG_DIR, CONTACT_EMAIL)
    
    # List to store tuples of (model, cycle_time) that need processing
    tasks_to_run = []

    print(f"Checking {len(models)} models at {current_time}")

    for model in models:
        status, cycle_time = model.check_download_status(current_time, MAX_WAIT_MINUTES)
        
        if status == "READY":
            tasks_to_run.append((model, cycle_time))
        else:
            print(f"{model.id}: {status}")

    if not tasks_to_run:
        print("No models ready for processing.")
        return

    # Use ProcessPoolExecutor to run tasks in parallel
    # max_workers defaults to number of processors on the machine. 
    # Adjust if you want to limit CPU usage (e.g., max_workers=2)
    with ProcessPoolExecutor() as executor:
        futures = []
        for model_obj, c_time in tasks_to_run:
            futures.append(executor.submit(process_single_model, model_obj, c_time))
        
        # Wait for all to complete
        for future in futures:
            # retrieve result to propagate exceptions if any occurred
            try:
                future.result() 
            except Exception as e:
                print(f"An error occurred in a worker process: {e}")

if __name__ == "__main__":
    while True:
        main()
        time.sleep(10)
