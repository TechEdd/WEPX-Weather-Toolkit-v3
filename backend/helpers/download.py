import yaml
import datetime
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple
import requests
import time
import os
import re
from urllib.parse import urlparse, parse_qs

@dataclass
class DownloadTask:
    urls: List[str]
    cycle_time: datetime.datetime
    model_id: str

class WeatherModelConfig:
    def __init__(self, yaml_path: str, contact_email: str):
        self.filepath = Path(yaml_path)
        self.contact_email = contact_email
        
        with open(self.filepath, 'r') as f:
            self.config = yaml.safe_load(f)

        self.id = self.config['metadata']['id']
        
        # Schedule shortcuts
        self.lead_minutes = self.config['schedule']['lead_minutes']
        self.interval_hours = self.config['schedule']['interval_hours']
        self.all_cycles = set(self.config['schedule']['all_cycles'])
        
        # Download config
        self.fhour_digits = self.config['download']['fhour_digits']
        self.url_template = self.config['download']['url_template']

    def get_forecast_duration(self, cycle_hour: int) -> int:
        """Determines forecast length based on whether it's a long or short run."""
        configs = self.config['schedule']['cycle_configs']
        
        # Check Long Run
        if cycle_hour in configs['long_run']['applies_to_hours']:
            return configs['long_run']['forecast_hours']
        
        # Check Short Run
        if cycle_hour in configs['short_run']['applies_to_hours']:
            return configs['short_run']['forecast_hours']
            
        return 0 # Default safety

    def check_download_status(self, current_time_utc: datetime.datetime, max_wait_minutes: int = 30) -> Tuple[str, Optional[datetime.datetime]]:
        """
        Checks if we are currently in a valid download window.
        Prioritizes finding a READY window over a WAITING window.
        """
        now_hour = current_time_utc.replace(minute=0, second=0, microsecond=0)
        
        best_status = "NO_CYCLE"
        best_cycle = None
        
        # We iterate back to find the first cycle that is READY.
        # If we find a READY cycle, we return immediately.
        # If we find a WAITING/MISSED cycle, we store it as a fallback 
        # in case no READY cycle exists.
        
        for i in range(24):
            check_time = now_hour - datetime.timedelta(hours=i)
            
            if check_time.hour in self.all_cycles:
                # Calculate window for this specific cycle candidate
                start_window = check_time + datetime.timedelta(minutes=self.lead_minutes)
                end_window = start_window + datetime.timedelta(minutes=max_wait_minutes)
                
                # Check status for this specific candidate
                if start_window <= current_time_utc <= end_window:
                    # We found an active window! Return immediately.
                    return "READY", check_time
                
                elif current_time_utc < start_window:
                    # We are early for this cycle. 
                    # Store it as a candidate, but keep looking back in case 
                    # the PREVIOUS cycle is still open (overlapping).
                    if best_status == "NO_CYCLE": # Only keep the closest WAITING
                        wait_seconds = (start_window - current_time_utc).total_seconds()
                        best_status = f"WAITING (Starts in {int(wait_seconds/60)} mins)"
                        best_cycle = check_time
                        
                else: 
                    # current_time > end_window (We missed this specific cycle)
                    # If we haven't found a "WAITING" or "READY" yet, this is our best guess.
                    if best_status == "NO_CYCLE":
                        best_status = "MISSED (Window closed)"
                        best_cycle = check_time
                        # If we missed the most recent cycle, it's unlikely a cycle 
                        # from 2 hours ago is valid (unless windows are huge), 
                        # but the loop continues just in case.

        return best_status, best_cycle

    def generate_url_list(self, cycle_time: datetime.datetime) -> List[str]:
        """Generates all URLs for the variables and time steps."""
        urls = []
        
        # Determine forecast length for this specific cycle (e.g. 18 vs 48)
        max_fhour = self.get_forecast_duration(cycle_time.hour)
        
        # Format parts for URL
        year = cycle_time.strftime("%Y")
        month = cycle_time.strftime("%m")
        day = cycle_time.strftime("%d")
        cycle = f"{cycle_time.hour:02d}"
        
        # Loop through all forecast hours (0 to max)
        for fhour in range(max_fhour + 1):
            # Format fhour (e.g., "02")
            fhour_str = f"{fhour:0{self.fhour_digits}d}"
            
            # Loop through all variables
            for var_config in self.config['variables']:
                
                # Construct the URL using the f-string template from YAML
                # We use .format() to inject the dynamic values
                url = self.url_template.format(
                    year=year,
                    month=month,
                    day=day,
                    cycle=cycle,
                    fhour=fhour_str,
                    internal_id=var_config['internal_id'],
                    grib_level=var_config['grib_level']
                )
                urls.append(url)
                
        return urls

    def create_task(self, cycle_time: datetime.datetime) -> DownloadTask:
        """Creates the standardized object containing URLs and Metadata."""
        urls = self.generate_url_list(cycle_time)
        
        return DownloadTask(
            urls=urls,
            cycle_time=cycle_time,
            model_id=self.id
        )

def load_all_models(config_dir: str, contact_email: str) -> List[WeatherModelConfig]:
    """Scans the directory and returns initialized model objects."""
    path = Path(config_dir)
    models = []
    for yaml_file in path.glob("*.yaml"):
        try:
            models.append(WeatherModelConfig(str(yaml_file), contact_email))
        except Exception as e:
            print(f"Error loading {yaml_file}: {e}")
    return models
    
def download_url(url, email=None, retry_delay=30, max_retries=30, username=None, password=None, output_filename=None):
    """
    Downloads a file from a URL with retry logic and optional authentication.
    
    Returns:
        str: The absolute filepath of the downloaded file if successful.
        bool: False if the download failed after all retries.
    """
    
    headers = {}
    if email:
        headers['User-Agent'] = f"PythonDownloader/1.0 (contact: {email})"
    
    auth = None
    if username and password:
        auth = (username, password)
        
    # Determine Output Filename
    if output_filename is None:
        if "nomads" in url:
            match = re.search(r"t(\d{2})z", url)
            if match:
                forecast_hour = str(match.group(1))
                output_filename = forecast_hour + "/" + url.split(".grib2&")[-1] + ".grib2"
            else:
                output_filename = url.split(".grib2&")[-1] + ".grib2"
                
        else:
            parsed_url = urlparse(url)
            # Check if it's a NOMADS/CGI style URL with a 'file' query parameter
            query_params = parse_qs(parsed_url.query)
            
            if 'file' in query_params:
                # Use the file parameter (e.g., hrrr.t00z.wrfsfcf01.grib2)
                output_filename = query_params['file'][0]
            else:
                # Fallback to the last part of the path
                output_filename = os.path.basename(parsed_url.path)
                if not output_filename:
                    output_filename = "downloaded_file.dat"

    print(f"Target filename: {output_filename}")

    # Retry Loop
    for attempt in range(1, max_retries + 1):
        try:
            # stream=True is important for large files to save memory
            with requests.get(url, headers=headers, auth=auth, stream=True, timeout=10) as response:
                
                # Check for HTTP errors (4xx or 5xx)
                response.raise_for_status()
                
                # Write to file
                output_dir = os.path.dirname(output_filename)
                if output_dir: 
                    os.makedirs(output_dir, exist_ok=True)
                with open(output_filename, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                        
            # Verification: Check if file exists and is not empty
            if os.path.exists(output_filename) and os.path.getsize(output_filename) > 0:
                return os.path.abspath(output_filename)
            
        except requests.exceptions.RequestException as e:
            print(f"Attempt {attempt}/{max_retries} failed: {e}")
            
            if attempt < max_retries:
                print(f"Waiting {retry_delay}s before retrying...")
                time.sleep(retry_delay)
            else:
                print("Max retries reached. Download failed.")
                
    return False