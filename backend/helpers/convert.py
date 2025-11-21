from osgeo import gdal, osr
import numpy as np
import math
import stream_encoder
import rioxarray
import uuid

NODATA = np.finfo(np.float32).min


def get_best_width_for_epsg4326(filepath):
    ds = gdal.Open(filepath)
    if not ds:
        print(f"Error opening {filepath}")
        return

    # Get Native Properties
    gt = ds.GetGeoTransform()
    native_res = gt[1]
    width = ds.RasterXSize
    height = ds.RasterYSize

    # Setup Transformation with FORCED Traditional Axis Order (Lon, Lat)
    source_srs = osr.SpatialReference()
    source_srs.ImportFromWkt(ds.GetProjection())
    
    # --- Force Traditional Order (Lon, Lat) ---
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    
    target_srs = osr.SpatialReference()
    target_srs.ImportFromEPSG(4326)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    
    transform = osr.CoordinateTransformation(source_srs, target_srs)

    # Walk the edges to find true Bounding Box
    # (Lambert projections curve, so corners aren't always the min/max)
    steps = 10 # Sample 10 points along each edge
    xs = np.linspace(gt[0], gt[0] + gt[1]*width, steps)
    ys = np.linspace(gt[3], gt[3] + gt[5]*height, steps)
    
    lons = []
    lats = []

    # Check Top and Bottom edges
    for x in xs:
        for y in [gt[3], gt[3] + gt[5]*height]:
            pnt = transform.TransformPoint(x, y)
            lons.append(pnt[0]) # 0 is always Lon with TRADITIONAL order
            lats.append(pnt[1])

    # Check Left and Right edges
    for y in ys:
        for x in [gt[0], gt[0] + gt[1]*width]:
            pnt = transform.TransformPoint(x, y)
            lons.append(pnt[0])
            lats.append(pnt[1])

    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    
    bbox_width = max_lon - min_lon

    # Calculate Resolution based on "Safe Latitude"
    # 3000m is roughly 0.027 degrees at equator, but 0.038 at 45N.
    # We use the Min Latitude (widest degrees) to ensure we never undersample.
    # If the grid crosses the equator, use 0.
    
    safe_lat = 0 if (min_lat < 0 < max_lat) else min(abs(min_lat), abs(max_lat))
    
    # Meters per degree longitude at this latitude
    meters_per_deg = 111320 * math.cos(math.radians(safe_lat))
    
    # The target resolution in degrees
    target_res_deg = native_res / meters_per_deg
    
    # Final Pixel Calculation
    final_width_px = math.ceil(bbox_width / target_res_deg)
    
    return final_width_px    

def calculateAspectRatio(extent):
    """
    Calculate the aspect ratio (width / height) of the raster from its extent.
    """
    x_min, y_min, x_max, y_max = tuple(extent)
    
    # Calculate width and height
    width = x_max - x_min  # Distance in the X direction (longitude or X axis)
    height = y_max - y_min  # Distance in the Y direction (latitude or Y axis)
    
    # Aspect ratio = width / height
    if height != 0:  # Prevent division by zero
        aspect_ratio = width / height
    else:
        aspect_ratio = None  # Undefined aspect ratio
    
    return aspect_ratio

def get_raster_extent_in_lonlat(dataset, model=None):
    """
    Get the extent of a raster in longitude and latitude (WGS84).

    This function opens a raster file and iterates to find the true highest and lowest
    lons and lats.

    Save the raster extent to a JSON file. If the model key exists, update its value.
    Otherwise, append the model key with the new value.

    Parameters:
    - GDAL dataset: dataset of raster to analyze
    - model (str): model name for indexing in file 
    - output_file (str): output file name for extent
                         if None, will not output file

    Returns:
    - list: A tuple list representing the extent (xmin, ymin, xmax, ymax) in 
             longitude and latitude.
    - file: A json file containing the model name and the extent if output_file is
            not None

    If the raster is already in lon/lat, the function returns the extent as is.
    Otherwise, it transforms the extent to lon/lat.
    """

    # Get the raster's geotransform and projection
    geotransform = dataset.GetGeoTransform()
    projection = dataset.GetProjection()
    
    # Get dataset dimensions
    x_size = dataset.RasterXSize
    y_size = dataset.RasterYSize

    # Extract extent in the original CRS (coordinate reference system)
    x_min = geotransform[0]
    y_max = geotransform[3]
    x_max = x_min + geotransform[1] * x_size
    y_min = y_max + geotransform[5] * y_size
    
    # Define the source projection
    source_proj = osr.SpatialReference()
    source_proj.ImportFromWkt(dataset.GetProjection())

    
    """

    code not working yet

    if ("Pole rotation" in projection):
        sample_rate = 1
        # Initialize min and max values
        lat_min, lon_max = float('inf'), -float('inf')
        lon_min, lat_max = float('inf'), -float('inf')
        lonp = float(projection.split(",")[projection.split(",").index('PARAMETER["Longitude of the southern pole (GRIB convention)"')+1])+180
        latp = -float(projection.split(",")[projection.split(",").index('PARAMETER["Latitude of the southern pole (GRIB convention)"')+1])
        for x in range(0, x_size, sample_rate):
            for y in [0, y_size - 1]:  # top and bottom edges
                # Get pixel (x, y) coordinates in dataset's projection
                lon_r = geotransform[0] + x * geotransform[1] + y * geotransform[2]
                lat_r = geotransform[3] + x * geotransform[4] + y * geotransform[5]

                # Transform the coordinates to lat/lon
                lon, lat = convert_pole_rotation_to_normal(lat_r, lon_r, lonp, latp)

                # Update min/max lat and lon
                lat_min = min(lat_min, lat)
                lat_max = max(lat_max, lat)
                lon_min = min(lon_min, lon)
                lon_max = max(lon_max, lon)

        for y in range(0, y_size, sample_rate):
            for x in [0, x_size - 1]:  # left and right edges
                # Get pixel (x, y) coordinates in dataset's projection
                lon_r = geotransform[0] + x * geotransform[1] + y * geotransform[2]
                lat_r = geotransform[3] + x * geotransform[4] + y * geotransform[5]

                # Transform the coordinates to lat/lon
                lon, lat = convert_pole_rotation_to_normal(lat_r, lon_r, lonp, latp)

                # Update min/max lat and lon
                lat_min = min(lat_min, lat)
                lat_max = max(lat_max, lat)
                lon_min = min(lon_min, lon)
                lon_max = max(lon_max, lon)
    """
    if (model=="HRDPS"):
        lat_min, lon_min, lat_max, lon_max = -152.78, 27.22, -40.7, 70.6 

    elif (source_proj.IsGeographic()):
        # Return the extent using the geotransform if already in lat/lon (WGS84)
        lon_max = geotransform[0]
        lon_min = geotransform[0] + dataset.RasterXSize * geotransform[1]
        lat_max = geotransform[3]
        lat_min = geotransform[3] + dataset.RasterYSize * geotransform[5]
    else:
        # Define the target projection (WGS84, lat/lon)
        target_proj = osr.SpatialReference()
        target_proj.ImportFromEPSG(4326)  # EPSG code for WGS84

        # Create a coordinate transformation object
        transform = osr.CoordinateTransformation(source_proj, target_proj)

        # Initialize min and max values
        lat_min, lon_max = float('inf'), -float('inf')
        lon_min, lat_max = float('inf'), -float('inf')

        #To avoid processing every single pixel, sample along the edges of the image at a specified rate
        #A lower sample_rate will make the result more accurate but slower.
        sample_rate = 10

        # Iterate over the dataset edges at the sample rate
        for x in range(0, x_size, sample_rate):
            for y in [0, y_size - 1]:  # top and bottom edges
                # Get pixel (x, y) coordinates in dataset's projection
                x_geo = geotransform[0] + x * geotransform[1]
                y_geo = geotransform[3] + y * geotransform[5]

                # Transform the coordinates to lat/lon
                lon, lat, _ = transform.TransformPoint(x_geo, y_geo)

                # Update min/max lat and lon
                lat_min = min(lat_min, lat)
                lat_max = max(lat_max, lat)
                lon_min = min(lon_min, lon)
                lon_max = max(lon_max, lon)

        for y in range(0, y_size, sample_rate):
            for x in [0, x_size - 1]:  # left and right edges
                # Get pixel (x, y) coordinates in dataset's projection
                x_geo = geotransform[0] + x * geotransform[1]
                y_geo = geotransform[3] + y * geotransform[5]

                # Transform the coordinates to lat/lon
                lon, lat, _ = transform.TransformPoint(x_geo, y_geo)

                # Update min/max lat and lon
                lat_min = min(lat_min, lat)
                lat_max = max(lat_max, lat)
                lon_min = min(lon_min, lon)
                lon_max = max(lon_max, lon)

    print([lat_min, lon_min, lat_max, lon_max])
    extent = [lat_min, lon_min, lat_max, lon_max]
    
    return extent


def convert_GRIB_to_Array(filepath, width=3000, model=None, extent=None):
    dataset = gdal.Open(filepath)
    geotransform = dataset.GetGeoTransform()
    projection = dataset.GetProjection()
    
    if (model == "HRRRSH"):
        #if hrrrsh run is at zero, than only one forecast
        if (int(dataset.GetRasterBand(1).GetMetadata()['GRIB_FORECAST_SECONDS']) != 0):
            numbersOfForecast = 4
        else:
            numbersOfForecast = 1
    else:
        numbersOfForecast = 1

    data_array = None
    for band in range(numbersOfForecast):
        bandObj = dataset.GetRasterBand(1)
        data_array = bandObj.ReadAsArray().astype(float)

    if (extent==None):
        extent = get_raster_extent_in_lonlat(dataset, model)

    #create virtual array for gdal
    driver = gdal.GetDriverByName('MEM')
    rows, cols= data_array.shape
    data_array_driver = driver.Create('', cols, rows, 1, gdal.GDT_Float32)
       
    # Inject the geotransform and projection into the new dataset
    data_array_driver.SetGeoTransform(geotransform)
    data_array_driver.SetProjection(projection)

    data_array_driver.GetRasterBand(1).WriteArray(data_array)

    height_resolution = width/calculateAspectRatio(extent)
    warped_ds = gdal.Warp(
        '',  # No filename needed for MEM
        data_array_driver,
        dstSRS="EPSG:4326",
        outputBounds=extent,
        width=int(width),
        height=int(height_resolution),
        outputType=gdal.GDT_Float32,
        dstNodata=NODATA,
        format="MEM"  # Returns a GDAL Dataset object, not a file path
    )
    
    data_array = warped_ds.ReadAsArray()
    data_array[data_array == NODATA] = np.nan
    data_array = np.array(data_array)

    return data_array
