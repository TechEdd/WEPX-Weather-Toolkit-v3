<?php
    // Initialize Error Reporting
    ini_set('display_errors', 1);
    ini_set('display_startup_errors', 1);
    error_reporting(E_ALL);

    require_once 'scripts/sanitizeFilename.php'; 
    require_once 'scripts/getLastRun.php';
    require_once 'scripts/ui_utils.php';

    // Helper: Polyfill for old PHP
    if (!function_exists('str_contains')) {
        function str_contains($haystack, $needle) {
            return $needle !== '' && mb_strpos($haystack, $needle) !== false;
        }
    }

    // Process Request Parameters
    $request = sanitizeFilename($_GET['request'] ?? 'model');
    $model   = sanitizeFilename($_GET['model'] ?? 'HRRR');
    
    if ($request === "radar") {
        $defaultVariable = "reflectivity_horizontal";
        $defaultLevel = "tilt1";
    } else {
        $defaultVariable = "REFC";
        $defaultLevel = "0-EATM";
    }
    
    $variable = sanitizeFilename($_GET['variable'] ?? $defaultVariable);
    $level    = sanitizeFilename($_GET['level'] ?? $defaultLevel);
    $run      = sanitizeFilename($_GET['run'] ?? getLastRun($model));

    // Get Configuration
    $uiConfig = getUiConfig($variable, $level);
    
    // Setup Globals
    $GLOBALS['default_colormap'] = $uiConfig['default_colormap'] ?? 'default';
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>WEPX Weather Toolkit</title>
    <script src="https://unpkg.com/topojson-client@3"></script>
    <style>
        /* --- Core Layout --- */
        body {
            margin: 0;
            overflow: hidden;
            user-select: none;
            background-color: #000;
            font-family: system-ui, -apple-system, sans-serif;
        }

        #container {
            width: 100vw;
            height: 100vh;
            position: relative;
            overflow: hidden;
            z-index: 1;
        }

        #map-viewport { 
            position: relative; 
            width: 100%; 
            height: 100%; 
            overflow: hidden; 
            touch-action: none;
        }

        #map-viewport canvas { 
            position: absolute; 
            top: 0; left: 0; 
            width: 100%; height: 100%; 
            outline: none;
            background-color: transparent !important;
        }

        /* --- Menus & Overlay UI --- */
        #menu {
            position: fixed;
            width: 18vw;
            height: 100vh;
            background-color: #1f1e1e;
            z-index: 60;
            overflow-x: hidden;
            box-shadow: 2px 0 5px rgba(0,0,0,0.5);
            transition: transform 0.3s ease;
        }

        #menu h1 {
            color: white;
            font-size: medium;
            text-align: center;
            cursor: pointer;
            padding: 10px 0;
            margin: 0;
        }

        /* Mobile Header Controls (Hidden on Desktop) */
        #mobile-header-controls {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 50px;
            background-color: #1f1e1e;
            z-index: 200; /* Highest priority */
            justify-content: space-around;
            align-items: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.5);
        }

        #mobile-header-controls button {
            background: transparent;
            border: 1px solid #444;
            color: white;
            padding: 8px 15px;
            border-radius: 4px;
            font-size: 0.9rem;
            cursor: pointer;
        }
        
        #mobile-header-controls button.active {
            background-color: #4CAF50;
            border-color: #4CAF50;
        }

        /* Scrollbar Styling */
        ::-webkit-scrollbar { width: 8px; background: transparent; }
        ::-webkit-scrollbar-thumb { background: #999; border-radius: 7px; }
        ::-webkit-scrollbar-thumb:hover { background: #555; }

        /* --- Top Info Bar --- */
        #upper_info {
            position: fixed;
            width: 82vw;
            background-color: rgba(31, 30, 30, 0.9);
            z-index: 99;
            right: 0;
            top: 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px 15px;
            box-sizing: border-box;
            color: white;
        }

        #upper_info h1 {
            font-size: 1rem;
            margin: 0;
            font-weight: normal;
        }

        .status-text {
            font-size: 0.8rem;
            color: #ccc;
            margin-left: 15px;
        }
        
        .indicator-group {
            display: flex;
            align-items: center;
        }
        
        /* Size Display Styling */
        #sizeDisplayContainer {
            margin-right: 10px;
            font-size: 0.8rem;
            color: #4CAF50; /* Green/Success color */
        }
        #sizeDisplay {
             font-weight: bold;
        }


        /* --- Timeline Control --- */
        #timeline_control {
            position: fixed;
            width: 82vw;
            height: 10vh;
            background-color: #1f1e1e;
            z-index: 99;
            right: 0;
            bottom: 0;
            display: flex;
            align-items: center;
            padding: 0 10px;
            box-sizing: border-box;
        }

        /* slider */

        .slider-container {
            position: relative;
            height: 100%;
            display: flex;
            align-items: center;
        }

        .slider {
            -webkit-appearance: none;
            width: 102%;
            height: 15px;
            left: -5px;
            border-radius: 5px;
            background: transparent;
            position: absolute;
            z-index: 4; /* Input slider is highest */
        }

        .slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 25px;
            height: 25px;
            border-radius: 50%;
            background: #333;
            cursor: pointer;
            z-index: 5;
            position: relative;
        }

        .slider::-moz-range-thumb {
            width: 25px;
            height: 25px;
            border-radius: 50%;
            background: #333;
            cursor: pointer;
        }

        .track {
            position: absolute;
            width: 100%;
            height: 15px;
            border-radius: 5px;
            background: lightgray;
            z-index: 0;
        }

        .fill-left {
            position: absolute;
            height: 15px;
            background: #83c8f2;
            border-radius: 5px 0 0 5px;
            z-index: 3; /* BLUE: Over track */
        }

        /* Removed .available class */

        .unavailable-rectangle {
            position: absolute;
            height: 15px;
            background: #919191;
            border-radius: 0 5px 5px 0;
            z-index: 1;
        }
		
        /* --- Settings & Tools --- */
        #settings-container {
            position: absolute;
            left: 20vw;
            bottom: 12vh;
            z-index: 150;
        }

        .icon-btn {
            background: rgba(30, 30, 30, 0.8);
            border: 1px solid #444;
            color: white;
            padding: 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 1.2rem;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .icon-btn:hover { background: #333; }

        #settings-menu {
            position: absolute;
            bottom: 50px;
            left: 0;
            background: rgba(30, 30, 30, 0.95);
            border: 1px solid #555;
            border-radius: 5px;
            padding: 10px;
            width: 220px;
            display: none;
            color: white;
            font-size: 0.9rem;
        }

        #settings-menu button {
            width: 100%;
            background: #444;
            border: none;
            color: white;
            padding: 8px;
            margin-bottom: 5px;
            cursor: pointer;
            text-align: left;
            border-radius: 3px;
        }

        #settings-menu button:hover { background: #555; }
        
        .setting-row {
            display: flex;
            align-items: center;
            margin: 5px 0;
            justify-content: space-between;
        }

        .setting-row label {
             margin-right: 10px;
             cursor: pointer;
        }
        
        /* New Select Styling */
        #unitSelect {
            background: #222;
            color: white;
            border: 1px solid #555;
            padding: 2px 5px;
            border-radius: 3px;
            max-width: 100px;
        }

        /* --- Tooltip --- */
        .tooltip {
            position: absolute;
            display: none; /* Controlled by JS */
            background-color: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 12px;
            pointer-events: none;
            z-index: 200;
            white-space: nowrap;
            border: 1px solid #444;
        }

        .tooltip.fixed-mode {
            top: 60px !important;
            left: 20vw !important; /* Offset from menu */
            margin-left: 10px;
        }

        /* --- Colormap Legend --- */
        #colormapDiv {
            position: absolute;
            right: 1vw;
            bottom: 12vh;
            z-index: 150;
            background: rgba(30, 30, 30, 0.8);
            padding: 10px;
            border-radius: 5px;
            text-align: center;
            color: white;
        }
        
        #colormapCanvas {
            border: 1px solid #555;
            display: block;
            margin: 5px auto;
        }

        /* --- Dropdown Styles --- */
        .dropdown-container {
          position: relative;
        }

        .dropdown-btn {
          background-color: #4CAF50;
          color: white;
          padding: 12px;
          font-size: 16px;
          border: none;
          width: 100%;
          cursor: pointer;
          text-align: left;
        }

        .dropdown-content {
          display: none;
          background-color: transparent;
          width: 100%;
          box-sizing: border-box;
          color: white;
          padding: 2px;
          user-select: none;
          -webkit-user-select: none;    
          -moz-user-select: none; 
          -ms-user-select: none;
          font-family: system-ui;
        }

        .dropdown-content a {
          display: block;
          padding: 4px;
          text-decoration: none;
          color: white;
          cursor: pointer;
          width: 100%;
          box-sizing: border-box;
          line-height: 1.2;
        }

        .dropdown-content a:hover {
              background-color: #333;
        }

        .nested-dropdown-content {
          display: none;
          padding-left: 20px;
        }
        
        .expandable {
          cursor: pointer;
          padding: 2px;
        }

        .arrow {
          float: right;
        }

        .open .arrow {
          transform: rotate(90deg);
        }

        /* ========================================= */
        /* MOBILE RESPONSIVE             */
        /* ========================================= */
        @media (max-width: 768px) {
            /* 1. Show Top Mobile Controls */
            #mobile-header-controls { display: flex; }

            /* 2. Menu becomes a full screen overlay/drawer */
            #menu {
                width: 100vw;
                height: calc(100vh - 50px);
                top: 50px;
                left: 0;
                transform: translateX(-100%); /* Hidden by default */
                padding-bottom: 20px;
                /* FIX: Increase z-index to sit ABOVE #upper_info (which is 99) */
                z-index: 105; 
            }
            #menu.mobile-open { transform: translateX(0); }
            
            /* Hide the main title inside menu on mobile since we have buttons */
            #menu > h1 { display: none; }

            /* 3. Top Info Bar adjustments */
            #upper_info {
                width: 100vw;
                top: 50px; /* Below mobile buttons */
                padding: 5px 10px;
                font-size: 0.8rem;
                z-index: 99; /* Ensure it stays below menu */
            }
            #upper_info h1 { font-size: 0.9rem; }
            #sizeDisplayContainer { display: none; } /* Hide file size to save space */

            /* 4. Timeline Control adjustments with Safe Area Support */
            #timeline_control {
                width: 100vw;
                /* Allow auto height to accommodate safe area padding */
                height: auto; 
                min-height: 12vh;
                left: 0;
                bottom: 0;
                /* Add safe area inset + regular padding */
                padding-bottom: calc(15px + env(safe-area-inset-bottom));
                padding-top: 10px;
                z-index: 99;
                /* Fix alignment if using flex */
                align-items: flex-start; 
            }
            .slider::-webkit-slider-thumb {
                width: 30px; height: 30px; /* Larger touch target */
            }

            /* 5. Settings and Colormap positioning - AGGRESSIVE LIFT */
            /* FIX: Use larger fixed offset (160px) to clear timeline + browser UI */
            #settings-container {
                left: 10px;
                bottom: 160px; /* Strongly lifted */
            }
            #colormapDiv {
                right: 10px;
                bottom: 160px; /* Strongly lifted */
                padding: 5px;
            }
            #colormapCanvas {
                width: 15px;
                height: 120px; /* Smaller legend on mobile */
            }

            /* 6. Utility classes for Selective Menu Display */
            /* Default: hide all sections */
            #section-model, #parametersMenu, #section-run { display: none; }
            
            /* Show based on active class on #menu */
            #menu.show-model #section-model { display: block; }
            #menu.show-param #parametersMenu { display: block; }
            #menu.show-run #section-run { display: block; }
            
            /* Expand dropdowns automatically on mobile for better UX */
            #menu.show-model .dropdown-content,
            #menu.show-param .dropdown-content,
            #menu.show-run .dropdown-content {
                display: block !important;
            }
            
            /* Hide the dropdown buttons on mobile since we auto-expand */
            .dropdown-btn { display: none; }
            
            /* Tooltip behavior */
            .tooltip.fixed-mode {
                top: 100px !important;
                left: 10px !important;
            }
        }
    </style>
</head>

<body>
    <script>
    // --- Export PHP Variables to JS ---
    let request = "<?php echo $request; ?>";
    let model = "<?php echo $model; ?>";
    let variable = "<?php echo $variable; ?>";
    let level = "<?php echo $level; ?>";
    let run1 = "<?php echo $run; ?>";
    let runNb = new Date(run1 * 1000).getUTCHours();
	
    // Output JS Variables
	<?php
    echo "  var var_name_en = " . json_encode($uiConfig['var_name_en'] ?? '') . ";\n";
    echo "  var default_colormap = " . json_encode($GLOBALS['default_colormap']) . ";\n";
    
    echo "  var initialUiConfig = " . json_encode($uiConfig) . ";\n";

    $unitsFile = __DIR__ . "/config/units.yaml";
    $unitsJson = "null";
    
    if (file_exists($unitsFile)) {
        $rawUnits = file_get_contents($unitsFile);
        if (function_exists('yaml_parse')) {
            $parsedUnits = yaml_parse($rawUnits);
            $unitsJson = json_encode($parsedUnits);
        } else {
            echo "console.warn('PHP YAML extension missing. Cannot parse units.yaml');";
        }
    }
    echo "  var globalUnitConfig = " . $unitsJson . ";\n";
    ?>
    
    var colorTable = <?php echo file_get_contents(__DIR__ . "/config/colormaps/". $GLOBALS['default_colormap'] . ".txt"); ?>;
    
    let sliderMaxAvailable = 1;

    // --- JS Helper Functions ---
    function getRadarLocationString(radarID) {
        const anchors = document.querySelectorAll('#radars a');
        for (let anchor of anchors) {
            if (anchor.textContent.trim() === radarID) return anchor.getAttribute('title');
        }
        return null;
    }
    
    function updateUrlVariable(key, value) {
        if (history.pushState) {
            let searchParams = new URLSearchParams(window.location.search);
            searchParams.set(key, value);
            let newurl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?' + searchParams.toString();
            window.history.pushState({path: newurl}, '', newurl);
        }
    }
    
    window.updatePreloadButton = function(isEnabled) {
        const btn = document.getElementById('btnPreload');
        if (btn) {
            btn.innerText = `Preload Images: ${isEnabled ? 'On' : 'Off'}`;
        }
    };
    
    window.togglePreloading = function() {
        console.error("togglePreloading not initialized yet.");
    };

    window.onload = function() {
        if (request == "model"){
            document.getElementById("modelIndicator").innerHTML = "Model: " + model;
            document.getElementById("runSelect").innerHTML = "Run: " + new Date(parseInt(run1*1000)).toISOString().replace('T', ' ').slice(0, 16) + 'z';
        } else if (request == "radar"){
            document.getElementById("modelIndicator").innerHTML = "Radar: " + model + " (" + getRadarLocationString(model) + ")";
        }

        if (request == "radar"){
            document.getElementById("layerIndicator").innerHTML = variable + " (" + level + ")";
        } else {
            const el = document.getElementById(variable);
            document.getElementById("layerIndicator").innerHTML = el ? el.innerHTML : variable;
        }
        
        initColormapLegend();
        updatePreloadButton(true); 
    };

    // --- Mobile Menu Logic ---
    function toggleMobileMenu(sectionId) {
        const menu = document.getElementById('menu');
        const buttons = document.querySelectorAll('#mobile-header-controls button');
        
        // Remove active class from buttons
        buttons.forEach(btn => btn.classList.remove('active'));

        // Check if we are closing the currently open section
        if (menu.classList.contains('mobile-open') && menu.classList.contains(sectionId)) {
            menu.classList.remove('mobile-open');
            menu.className = ''; // Reset classes
            return;
        }

        // Open new section
        menu.className = ''; // Reset
        menu.classList.add('mobile-open');
        menu.classList.add(sectionId);
        
        // Highlight active button
        const activeBtn = document.querySelector(`button[onclick="toggleMobileMenu('${sectionId}')"]`);
        if(activeBtn) activeBtn.classList.add('active');
    }
    </script>

    <div id="mobile-header-controls">
        <button onclick="toggleMobileMenu('show-model')">Model</button>
        <button onclick="toggleMobileMenu('show-param')">Parameter</button>
        <button onclick="toggleMobileMenu('show-run')">Run</button>
    </div>

    <div id="menu">
        <h1 onclick="window.location.href='/'">WEPX Weather Toolkit</h1>
        
        <div id="section-model">
            <?php include("menus/dropdownmenu.html") ?>
        </div>

        <div id="parametersMenu">
            <?php 
                if ($request == "model") include("menus/{$model}menu.html");
                else if ($request == "radar") {
                    if (str_contains($model, "CA")) include("menus/canadianRadarMenu.html"); 
                    else include("menus/radarmenu.html"); 
                }
            ?>
        </div>
        
        <div id="section-run">
            <div class="dropdown-container">
                <button id="runSelect" class="dropdown-btn" onclick="toggleDropdown('dropdownRun')">Run</button>
                <div id="dropdownRun" class="dropdown-content">
                    <?php include("scripts/getRuns.php") ?>
                </div>
            </div>
        </div>
    </div>

    <div id="upper_info">
        <div class="indicator-group">
            <h1 id="modelIndicator">Model: </h1>
            <span id="statusText" class="status-text">Ready</span>
        </div>
        <div class="indicator-group">
             <span id="sizeDisplayContainer">Size: <span id="sizeDisplay">0.00 MB</span></span>
             <h1 id="layerIndicator">Layer: </h1>
        </div>
    </div>

    <div id="timeline_control">
        <div id="animateButtonDiv" style="width: 50px; display: flex; justify-content: center;">
            <button id="animateButton" style="border: none; background: transparent; cursor: pointer; padding: 10px;">
                <svg class="play-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                    <polygon points="5 3, 19 12, 5 21"></polygon>
                </svg>
                <svg class="pause-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" style="display:none;">
                    <rect x="6" y="4" width="4" height="16"></rect>
                    <rect x="14" y="4" width="4" height="16"></rect>
                </svg>
            </button>
        </div>
        <div class="slider-container" style="width: 100%;">
			<div class="track"></div>
			<div class="fill-left"></div>
			<div class="unavailable-rectangle"></div>
			<input type="range" min="0" max="48" value="0" class="slider" id="timeSlider">
		</div>
        <div style="width: 150px; text-align: center;">
            <h3 id="timeDisplay" style="color: white; margin: 0; font-family: monospace;">--:--</h3>
        </div>
    </div>

    <div id="container">
        <div id="settings-container">
            <div id="settings-btn" class="icon-btn" title="Map Settings" onclick="toggleSettingsMenu()">
                ⚙️
            </div>
            <div id="settings-menu">
                <button id="btnProj" onclick="map.toggleProjection()">Projection: Cylindrical</button>
                <button id="btnTooltipState" onclick="map.toggleTooltipState()">Tooltip: Enabled</button>
                <button id="btnTooltipMode" onclick="map.toggleTooltipMode()">Mode: Follow Mouse</button>
                <button id="btnInterpolation" onclick="map.toggleInterpolation()">Smoothing: On</button>
                <button id="btnDarkMode" onclick="map.toggleDarkMode()">Dark Mode: Off</button>
                <button id="btnPreload" onclick="togglePreloading()">Preload Images: On</button> 
                
                <div class="setting-row">
                    <label><input type="checkbox" id="chkLatLon" checked onchange="map.toggleLatLon(this.checked)"> Show Lat/Lon</label>
                </div>
                <div class="setting-row">
                    <label><input type="checkbox" id="chkValue" checked onchange="map.toggleValue(this.checked)"> Show Value</label>
                </div>
                <div class="setting-row" id="unitSettingRow" style="display:none;">
                    <label for="unitSelect">Unit:</label>
                    <select id="unitSelect"></select>
                </div>
				<div id="contrast-controls" style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #555;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                        <span style="font-size: 0.8rem; color: #aaa; text-transform: uppercase;">Contrast / Range</span>
                        <button onclick="ContrastManager.reset()" style="width: auto; padding: 2px 8px; font-size: 0.7rem; background: #00bcd4; border: none; border-radius: 3px; cursor: pointer; color: black;">Reset</button>
                    </div>
                    
                    <div style="margin-bottom: 8px;">
                        <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: #ccc; margin-bottom: 2px;">
                            <span>Min</span>
                            <span id="vmin-display">-</span>
                        </div>
                        <input type="range" id="contrast-vmin" step="any" style="width: 100%; height: 4px; background: #555; border-radius: 2px; -webkit-appearance: none; outline: none;" 
                               oninput="ContrastManager.handleInput('min', this.value)">
                    </div>

                    <div style="margin-bottom: 5px;">
                        <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: #ccc; margin-bottom: 2px;">
                            <span>Max</span>
                            <span id="vmax-display">-</span>
                        </div>
                        <input type="range" id="contrast-vmax" step="any" style="width: 100%; height: 4px; background: #555; border-radius: 2px; -webkit-appearance: none; outline: none;" 
                               oninput="ContrastManager.handleInput('max', this.value)">
                    </div>
                </div>
            </div>
        </div>

        <div id="colormapDiv">
            <p id="colormapVariable" style="margin:0 0 5px 0; font-size:12px;"><?php echo $GLOBALS['default_colormap']; ?></p>
            <canvas id="colormapCanvas" width="20" height="200"></canvas>
        </div>

        <div id="tooltip" class="tooltip"></div>
        <div id="status" style="display:none;"></div>
        
        <div id="map-viewport"></div>
    </div>

    <script id="vertex-shader" type="x-shader/x-vertex">
        attribute vec2 a_position;
        attribute vec2 a_uv;
        uniform float u_morph;
        uniform vec2 u_scale;
        uniform vec2 u_offset;
        uniform vec2 u_resolution;
        varying vec2 v_uv;
        const float PI = 3.14159265359;

        float mercy(float lat) {
            float latClamped = clamp(lat, -1.48, 1.48); 
            return log(tan((PI / 4.0) + (latClamped / 2.0)));
        }

        void main() {
            v_uv = a_uv;
            vec2 posCyl = a_position; 
            vec2 posMerc = vec2(a_position.x, mercy(a_position.y));
            vec2 worldPos = mix(posCyl, posMerc, u_morph);
            vec2 cameraPos = (worldPos * u_scale) + u_offset;
            float aspect = u_resolution.x / u_resolution.y;
            vec2 clipSpace = cameraPos;
            clipSpace.x /= aspect; 
            gl_Position = vec4(clipSpace, 0.0, 1.0);
            gl_PointSize = 3.0;
        }
    </script>

    <script id="fragment-shader" type="x-shader/x-fragment">
    precision mediump float;
    varying vec2 v_uv;
    
    uniform float u_isRaster;
    uniform float u_opacity;
    uniform vec4 u_color;
    
    // GPU LUT Uniforms
    uniform sampler2D u_dataTexture; 
    uniform sampler2D u_lutTexture;  
    uniform float u_dataMin;
    uniform float u_dataMax;

    void main() {
        if (u_isRaster > 0.5) {
            vec4 rawData = texture2D(u_dataTexture, v_uv);
            float value = rawData.r; 
            float mask = rawData.a;  

            if (mask < 0.5) discard;

            float normalized = (value - u_dataMin) / (u_dataMax - u_dataMin);
            vec4 lutColor = texture2D(u_lutTexture, vec2(clamp(normalized, 0.001, 0.999), 0.5));
            
            gl_FragColor = vec4(lutColor.rgb, lutColor.a * u_opacity);
        } else {
            gl_FragColor = u_color;
        }
    }
    </script>

    <script src="js/map.js"></script>
    <script>
        const map = new AdaptiveMap('map-viewport', 'tooltip');
        
        map.addLayer('topoJSON/countries-50m.json', 'countries', [0.1, 0.1, 0.1, 0.9]);
        let statesId = null;
        map.addLayer('topoJSON/states-50m.json', 'states', [0.1, 0.1, 0.1, 0.9]).then(id => statesId = id);

        function toggleSettingsMenu() {
            const m = document.getElementById('settings-menu');
            m.style.display = m.style.display === 'block' ? 'none' : 'block';
        }

        function initColormapLegend() {
            const cv = document.getElementById('colormapCanvas');
            const cx = cv.getContext('2d');
            const w = cv.width;
            const h = cv.height;

            if (typeof colorTable === 'undefined' || !colorTable) return;

            const sorted = [...colorTable].sort((a,b) => a.value - b.value);
            const min = sorted[0].value;
            const max = sorted[sorted.length - 1].value;

            const grad = cx.createLinearGradient(0, h, 0, 0); 
            
            sorted.forEach(pt => {
                let t = (pt.value - min) / (max - min);
                if (max === min) t = 0;
                const c = pt.color;
                grad.addColorStop(t, `rgba(${c[0]},${c[1]},${c[2]},${c[3]/255})`);
            });

            cx.fillStyle = grad;
            cx.fillRect(0, 0, w, h);
        }

        function updateStatusUI() {
            const st = document.getElementById('status');
            const stText = document.getElementById('statusText');
            if (st && stText && st.innerText) {
                stText.innerText = st.innerText;
            }
            requestAnimationFrame(updateStatusUI);
        }
        updateStatusUI();

    </script>
    <script src='js/stream.js'></script>
    <script src='js/menuGenerator.js'></script>
</body>
</html>