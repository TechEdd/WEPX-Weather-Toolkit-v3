from osgeo import gdal, osr
import numpy as np
import math
import stream_encoder
import rioxarray
import uuid

gdal.UseExceptions()

NODATA = np.finfo(np.float32).min

def get_best_width_for_epsg4326(filepath):
    ds = gdal.Open(filepath)
    if not ds:
        print(f"Error opening {filepath}")
        return 3000 # Default fallback

    gt = ds.GetGeoTransform()
    native_res = gt[1]
    width = ds.RasterXSize
    height = ds.RasterYSize

    # Setup Transformation with FORCED Traditional Axis Order (Lon, Lat)
    source_srs = osr.SpatialReference()
    source_srs.ImportFromWkt(ds.GetProjection())
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    
    target_srs = osr.SpatialReference()
    target_srs.ImportFromEPSG(4326)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    
    transform = osr.CoordinateTransformation(source_srs, target_srs)

    # Sample edges
    steps = 10
    lats = []
    lons = []
    
    xs = np.linspace(gt[0], gt[0] + gt[1]*width, steps)
    ys = np.linspace(gt[3], gt[3] + gt[5]*height, steps)

    # Edges logic
    for x in xs:
        for y in [gt[3], gt[3] + gt[5]*height]:
            pnt = transform.TransformPoint(x, y)
            lons.append(pnt[0])
            lats.append(pnt[1])
            
    for y in ys:
        for x in [gt[0], gt[0] + gt[1]*width]:
            pnt = transform.TransformPoint(x, y)
            lons.append(pnt[0])
            lats.append(pnt[1])

    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    bbox_width = max_lon - min_lon
    
    if source_srs.IsGeographic():
        target_res_deg = native_res
    else:
        # Only convert if source is Projected (Meters)
        safe_lat = 0 if (min_lat < 0 < max_lat) else min(abs(min_lat), abs(max_lat))
        meters_per_deg = 111320 * math.cos(math.radians(safe_lat))
        target_res_deg = native_res / meters_per_deg

    final_width_px = math.ceil(bbox_width / target_res_deg)
    
    return final_width_px    

def calculateAspectRatio(extent):
    x_min, y_min, x_max, y_max = tuple(extent)
    width = x_max - x_min
    height = y_max - y_min
    if height != 0:
        return width / height
    return 1.0

def get_raster_extent_in_lonlat(filepath, model=None):
    dataset = gdal.Open(filepath)
    geotransform = dataset.GetGeoTransform()
    x_size = dataset.RasterXSize
    y_size = dataset.RasterYSize
    
    source_proj = osr.SpatialReference()
    source_proj.ImportFromWkt(dataset.GetProjection())

    if (model=="HRDPS"):
        # Hardcoded extent for HRDPS
        return [-152.78, 27.22, -40.7, 70.6] 

    elif (source_proj.IsGeographic()):
        lon_max = geotransform[0]
        lon_min = geotransform[0] + dataset.RasterXSize * geotransform[1]
        lat_max = geotransform[3]
        lat_min = geotransform[3] + dataset.RasterYSize * geotransform[5]
        return [min(lat_min, lat_max), min(lon_min, lon_max), max(lat_min, lat_max), max(lon_min, lon_max)]
    else:
        target_proj = osr.SpatialReference()
        target_proj.ImportFromEPSG(4326)
        transform = osr.CoordinateTransformation(source_proj, target_proj)

        lat_min, lon_max = float('inf'), -float('inf')
        lon_min, lat_max = float('inf'), -float('inf')

        sample_rate = 10
        for x in range(0, x_size, sample_rate):
            for y in [0, y_size - 1]:
                x_geo = geotransform[0] + x * geotransform[1]
                y_geo = geotransform[3] + y * geotransform[5]
                lon, lat, _ = transform.TransformPoint(x_geo, y_geo)
                lat_min = min(lat_min, lat)
                lat_max = max(lat_max, lat)
                lon_min = min(lon_min, lon)
                lon_max = max(lon_max, lon)

        for y in range(0, y_size, sample_rate):
            for x in [0, x_size - 1]:
                x_geo = geotransform[0] + x * geotransform[1]
                y_geo = geotransform[3] + y * geotransform[5]
                lon, lat, _ = transform.TransformPoint(x_geo, y_geo)
                lat_min = min(lat_min, lat)
                lat_max = max(lat_max, lat)
                lon_min = min(lon_min, lon)
                lon_max = max(lon_max, lon)

    return [lat_min, lon_min, lat_max, lon_max]


def process_multi_band_grib(filepath, width, variables_config, model=None, saveExtent=None):
    """
    Opens a GRIB file, iterates through all bands, finds matches in the variables_config,
    warps to EPSG:4326, and returns processed data as 16-bit Floats for high compression.
    """
    ds = gdal.Open(filepath)
    if not ds:
        print(f"Failed to open {filepath}")
        return []

    results = []
    
    # Cache extent calculation to avoid doing it for every band
    extent = get_raster_extent_in_lonlat(filepath, model)
    
    # Iterate through all bands in the GRIB file
    for i in range(1, ds.RasterCount + 1):
        band = ds.GetRasterBand(i)
        meta = band.GetMetadata()
        
        grib_element = meta.get('GRIB_ELEMENT', '').strip()
        grib_short_name = meta.get('GRIB_SHORT_NAME', '').strip() 
        
        matched_config = None
        for var_conf in variables_config:
            if grib_element != var_conf['grib_id']:
                continue

            config_level = var_conf.get('grib_level', '').strip()
            
            if config_level and config_level != grib_short_name:
                continue 
            
            matched_config = var_conf
            break
            
        if matched_config:
            # --- Extraction ---
            stream_id = f"{matched_config['internal_id']}_{matched_config['grib_level']}"
            ref_time = meta.get('GRIB_REF_TIME', '0').split()[0]
            valid_time = meta.get('GRIB_VALID_TIME', '0').split()[0]
            
            print(f"  Found {stream_id} in Band {i} (Ref: {ref_time}, Valid: {valid_time})")

            # --- Conversion (Warping) ---
            # Read raw array as float32 for initial processing
            raw_data = band.ReadAsArray().astype(np.float32)
            
            if "formula" in matched_config:
                formula = matched_config["formula"]
                print(f"Doing {formula}")
                x = raw_data
                eval_globals = {"np": np}
                eval_locals = {"x": x}
                # Ensure result of formula stays valid before casting
                raw_data = eval(formula, eval_globals, eval_locals)
            
            # Setup In-Memory Driver for warping
            driver = gdal.GetDriverByName('MEM')
            rows, cols = raw_data.shape
            mem_ds = driver.Create('', cols, rows, 1, gdal.GDT_Float32)
            mem_ds.SetGeoTransform(ds.GetGeoTransform())
            mem_ds.SetProjection(ds.GetProjection())
            mem_ds.GetRasterBand(1).WriteArray(raw_data)
            
            # Calculate height based on aspect ratio
            height_resolution = width / calculateAspectRatio(extent)
            
            # Warp to EPSG:4326 (Keep float32 for warp accuracy)
            warped_ds = gdal.Warp(
                '',
                mem_ds,
                dstSRS="EPSG:4326",
                outputBounds=extent,
                width=int(width),
                height=int(height_resolution),
                outputType=gdal.GDT_Float32,
                dstNodata=np.nan,
                format="MEM"
            )
            
            # CAST TO FLOAT16 HERE
            # This strips the 32-bit noise before it ever reaches the encoder
            final_array = warped_ds.ReadAsArray().astype(np.float16)
            
            results.append({
                'stream_id': stream_id,
                'data': final_array,
                'ref_time': str(int(ref_time)),
                'valid_time': str(int(valid_time)),
                'extent': extent
            })
            
    return results