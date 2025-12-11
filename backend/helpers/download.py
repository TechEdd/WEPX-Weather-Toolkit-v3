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

# --- GLOBAL CONFIGURATION ---
DOWNLOAD_BASE_DIR = "./data"

@dataclass
class DownloadTask:
    urls: List[str]
    cycle_time: datetime.datetime
    model_id: str
    variables_config: List[Dict] # Passing config to assist conversion later

class WeatherModelConfig:
    def __init__(self, yaml_path: str, contact_email: str):
        self.filepath = Path(yaml_path)
        self.contact_email = contact_email
        
        with open(self.filepath, 'r') as f:
            self.config = yaml.safe_load(f)

        self.id = self.config['metadata']['id']
        self.source_agency = self.config['metadata'].get('source_agency', 'GENERIC')
        
        # Schedule shortcuts
        self.lead_minutes = self.config['schedule']['lead_minutes']
        self.interval_hours = self.config['schedule']['interval_hours']
        self.all_cycles = set(self.config['schedule']['all_cycles'])
        
        # Download config
        self.fhour_digits = self.config['download']['fhour_digits']
        self.url_template = self.config['download']['url_template']
        self.url_variable_template = self.config['download'].get('url_variable_template', "")

    def get_forecast_duration(self, cycle_hour: int) -> int:
        """Determines forecast length based on whether it's a long or short run."""
        try:
            configs = self.config['schedule']['cycle_configs']
            # Check Long Run
            if cycle_hour in configs['long_run']['applies_to_hours']:
                return configs['long_run']['forecast_hours']
            # Check Short Run
            if cycle_hour in configs['short_run']['applies_to_hours']:
                return configs['short_run']['forecast_hours']
        except:
            print("Simple forecast config")
            if cycle_hour in self.all_cycles:
                return self.config['schedule']['forecast_hours']
            
        return 0 # Default safety

    def check_download_status(self, current_time_utc: datetime.datetime, max_wait_minutes: int = 30) -> Tuple[str, Optional[datetime.datetime]]:
        """
        Checks if we are currently in a valid download window.
        Prioritizes finding a READY window over a WAITING window.
        """
        now_hour = current_time_utc.replace(minute=0, second=0, microsecond=0)
        
        best_status = "NO_CYCLE"
        best_cycle = None
        
        for i in range(24):
            check_time = now_hour - datetime.timedelta(hours=i)
            
            if check_time.hour in self.all_cycles:
                # Calculate window for this specific cycle candidate
                start_window = check_time + datetime.timedelta(minutes=self.lead_minutes)
                end_window = start_window + datetime.timedelta(minutes=max_wait_minutes)
                
                # Check status for this specific candidate
                if start_window <= current_time_utc <= end_window:
                    return "READY", check_time
                
                elif current_time_utc < start_window:
                    if best_status == "NO_CYCLE": # Only keep the closest WAITING
                        wait_seconds = (start_window - current_time_utc).total_seconds()
                        best_status = f"WAITING (Starts in {int(wait_seconds/60)} mins)"
                        best_cycle = check_time
                        
                else: 
                    if best_status == "NO_CYCLE":
                        best_status = "MISSED (Window closed)"
                        best_cycle = check_time

        return best_status, best_cycle

    def generate_url_list(self, cycle_time: datetime.datetime) -> List[str]:
        """Generates URLs. Aggregates variables if agency is NOMADS."""
        urls = []
        
        max_fhour = self.get_forecast_duration(cycle_time.hour)
        
        year = cycle_time.strftime("%Y")
        month = cycle_time.strftime("%m")
        day = cycle_time.strftime("%d")
        cycle = f"{cycle_time.hour:02d}"
        
        # --- NOMADS OPTIMIZATION: One URL per Forecast Hour (All Variables) ---
        if self.source_agency == "NOMADS":
            for fhour in range(max_fhour + 1):
                fhour_str = f"{fhour:0{self.fhour_digits}d}"
                
                # 1. Build the list of variable query parameters
                variable_params = []
                for var_config in self.config['variables']:
                    # Example: "var_REFC=on&lev_entire_atmosphere=on"
                    param = self.url_variable_template.format(
                        url_id=var_config['url_id'],
                        url_level=var_config['url_level']
                    )
                    variable_params.append(param)
                
                # 2. Join all variables with '&'
                combined_query = "&".join(variable_params)
                
                # 3. Construct Base URL (using the template, but usually the template includes variable placeholders)
                # We assume url_template ends before the variable part or we append to it.
                # However, your yaml template is: ...filter_hrrr_2d.pl?dir=...&file=...
                # We need to append the combined query to the base template.
                
                base_url = self.url_template.format(
                    year=year,
                    month=month,
                    day=day,
                    cycle=cycle,
                    fhour=fhour_str
                )
                
                # Ensure we join correctly
                full_url = f"{base_url}&{combined_query}"
                urls.append(full_url)

        # --- GENERIC / LEGACY: One URL per Variable per Forecast Hour ---
        else:
            for fhour in range(max_fhour + 1):
                fhour_str = f"{fhour:0{self.fhour_digits}d}"
                for var_config in self.config['variables']:
                    # Skip if in yaml
                    if 'skip' in var_config and fhour in var_config['skip']:
                        continue
                    # Note: This assumes url_template expects url_id/grib_level slots
                    # This path is a fallback.
                    url = self.url_template.format(
                        year=year,
                        month=month,
                        day=day,
                        cycle=cycle,
                        fhour=fhour_str,
                        url_id=var_config['url_id'],
                        url_level=var_config['url_level']
                    )
                    urls.append(url)
                
        return urls

    def create_task(self, cycle_time: datetime.datetime) -> DownloadTask:
        """Creates the standardized object containing URLs and Metadata."""
        urls = self.generate_url_list(cycle_time)
        
        return DownloadTask(
            urls=urls,
            cycle_time=cycle_time,
            model_id=self.id,
            variables_config=self.config['variables']
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
    Downloads a file from a URL.
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
                # Generate a unique name for the aggregated file
                # e.g., hrrr.t12z.wrfsfcf00.multi.grib2
                base_name = url.split("file=")[1].split("&")[0]
                output_filename = os.path.join(DOWNLOAD_BASE_DIR, forecast_hour, base_name)
            else:
                output_filename = os.path.join(DOWNLOAD_BASE_DIR, "unknown_fhour.grib2")
                
        else:
            parsed_url = urlparse(url)
            output_filename = os.path.join(DOWNLOAD_BASE_DIR, os.path.basename(parsed_url.path))

    print(f"Target filename: {output_filename}")

    # Retry Loop
    for attempt in range(1, max_retries + 1):
        try:
            with requests.get(url, headers=headers, auth=auth, stream=True, timeout=30) as response:
                response.raise_for_status()
                output_dir = os.path.dirname(output_filename)
                if output_dir: 
                    os.makedirs(output_dir, exist_ok=True)
                with open(output_filename, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                        
            if os.path.exists(output_filename) and os.path.getsize(output_filename) > 0:
                return os.path.abspath(output_filename)
            
        except requests.exceptions.RequestException as e:
            print(f"Attempt {attempt}/{max_retries} failed: {e}")
            if attempt < max_retries:
                time.sleep(retry_delay)
            else:
                print("Max retries reached. Download failed.")
                
    return False