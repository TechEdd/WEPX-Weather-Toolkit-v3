// --- Constants ---
const host = window.location.hostname;
const STREAM_MAIN = 0x00;
const FRAME_TYPE_I = 0x00;
const FRAME_TYPE_P = 0x01;

// --- State ---
let frames = []; 
let meta = null; 
let currentFrameIndex = 0;
let frameCount = 0;
let totalBytesReceived = 0;
let ws = null; 
let timeDisplay, statusEl, sizeEl; 

// --- Time Format State ---
let useLocalTime = false; // Toggle state for Z vs Local

// --- Unit State ---
let currentUnit = null; // The unit currently selected by the user
let sourceUnit = null;  // The unit coming from the GRIB/Model (grib_unit)

// --- Race Condition Handling ---
let loadGeneration = 0; // Increment on every reload to invalidate old fetches

// --- Slider "Sticky" State ---
// Explicitly attached to window so menuGenerator.js can see it for lock logic
window.targetFrameIndex = -1; 
let stallTimeout = null;   // Timer to snap back if stream stalls
const STALL_THRESHOLD = 800; // ms to wait before giving up on a frame

// --- Background Generation State ---
let isGenerating = false;
let generationQueueTimer = null;
let downloadIdleTimer = null; // Wait for network idle before processing images
let isPreloadingEnabled = true; // Preloading is ON by default

// --- LUT Logic ---
const GRADIENT_STEPS = 1024;
let gradientCache = new Uint8Array(GRADIENT_STEPS * 4);
let lutMin = 0, lutMax = 1;

// --- Raster State ---
let rasterId = null;        // The CURRENT active raster (being built)
let previousRasterId = null;// The OLD raster (kept visible until new one is ready)

// --- Helper: Time Formatting ---
function getFormattedTime(unixTime) {
    const date = new Date(unixTime * 1000);
    
    if (!useLocalTime) {
        // UTC / Zulu Format
        return date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    } else {
        // Local Format (Matches ISO style but uses local time)
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        
        // Attempt to grab timezone abbreviation (e.g., EST, EDT, CST)
        let tz = 'Loc';
        try {
            const parts = date.toLocaleTimeString('en-us', { timeZoneName: 'short' }).split(' ');
            tz = parts[parts.length - 1]; 
        } catch (e) { /* fallback */ }
        
        return `${year}-${month}-${day} ${hours}:${minutes} ${tz}`;
    }
}

window.ContrastManager = {
    baseMin: 0,
    baseMax: 1,
    debounceTimer: null,
    
    // Initialize UI based on the loaded colormap
    setup: function(min, max) {
        min = parseFloat(min);
        max = parseFloat(max);
        this.baseMin = min;
        this.baseMax = max;
        
        let range = max - min;
        if (range <= 0.00001) range = 1.0; 
        
        const padding = range * 0.20; 
        const uiMin = min - padding;
        const uiMax = max + padding;
        
        const sMin = document.getElementById('contrast-vmin');
        const sMax = document.getElementById('contrast-vmax');
        const dMin = document.getElementById('vmin-display');
        const dMax = document.getElementById('vmax-display');
        
        if (!sMin || !sMax) return;

        sMin.min = uiMin; sMin.max = uiMax;
        sMax.min = uiMin; sMax.max = uiMax;
        sMin.step = range / 500; 
        sMax.step = range / 500;
        sMin.value = min;
        sMax.value = max;
        
        if(dMin) dMin.innerText = min.toFixed(2);
        if(dMax) dMax.innerText = max.toFixed(2);
        
        lutMin = min;
        lutMax = max;

        // Update GPU immediately
        // FIX: Only update the NEW active raster. 
        // We strictly ignore 'previousRasterId' so the old image stays frozen with its correct colors.
        if (typeof map !== 'undefined' && rasterId) {
            map.updateRasterParams(rasterId, lutMin, lutMax);
        }
    },

    handleInput: function(type, val) {
        val = parseFloat(val);
        const sMin = document.getElementById('contrast-vmin');
        const sMax = document.getElementById('contrast-vmax');
        const dMin = document.getElementById('vmin-display');
        const dMax = document.getElementById('vmax-display');
        
        let currentRailMin = parseFloat(sMin.min);
        let currentRailMax = parseFloat(sMin.max);
        let currentSpan = currentRailMax - currentRailMin;
        if(currentSpan <= 0) currentSpan = 1;

        if (type === 'min') {
            const currentMaxVal = parseFloat(sMax.value);
            if (val >= currentMaxVal) val = currentMaxVal - (currentSpan * 0.005);
            lutMin = val;
            if(dMin) dMin.innerText = val.toFixed(2);
            if (val <= currentRailMin + (currentSpan * 0.01)) {
                const expand = currentSpan * 0.20;
                const newRailMin = currentRailMin - expand;
                sMin.min = newRailMin;
                sMax.min = newRailMin; 
            }
        } else {
            const currentMinVal = parseFloat(sMin.value);
            if (val <= currentMinVal) val = currentMinVal + (currentSpan * 0.005);
            lutMax = val;
            if(dMax) dMax.innerText = val.toFixed(2);
            if (val >= currentRailMax - (currentSpan * 0.01)) {
                const expand = currentSpan * 0.20;
                const newRailMax = currentRailMax + expand;
                sMin.max = newRailMax;
                sMax.max = newRailMax;
            }
        }

        // Instant Update (GPU Uniforms)
        // FIX: Do not touch previousRasterId.
        if (typeof map !== 'undefined' && rasterId) {
            map.updateRasterParams(rasterId, lutMin, lutMax);
        }
    },

    reset: function() {
        this.setup(this.baseMin, this.baseMax);
    }
};

function buildGradientCache() {
    if (typeof colorTable === 'undefined' || !colorTable || colorTable.length === 0) return;
    
    colorTable.sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
    
    let baseLutMin = parseFloat(colorTable[0].value);
    let baseLutMax = parseFloat(colorTable[colorTable.length - 1].value);
    
    if (Math.abs(baseLutMax - baseLutMin) < 0.0001) baseLutMax += 0.01; 

    if (window.ContrastManager) {
        window.ContrastManager.setup(baseLutMin, baseLutMax);
    }
    
    lutMin = baseLutMin;
    lutMax = baseLutMax;

    for (let i = 0; i < GRADIENT_STEPS; i++) {
        let val = baseLutMin + (i / (GRADIENT_STEPS - 1)) * (baseLutMax - baseLutMin);
        let lower = colorTable[0], upper = colorTable[colorTable.length - 1];
        
        for (let k = 0; k < colorTable.length - 1; k++) {
            if (val >= parseFloat(colorTable[k].value) && val <= parseFloat(colorTable[k+1].value)) {
                lower = colorTable[k]; upper = colorTable[k+1]; break;
            }
        }
        
        let t = (val - parseFloat(lower.value)) / (parseFloat(upper.value) - parseFloat(lower.value) || 1);
        let off = i * 4;
        gradientCache[off]   = lower.color[0] + (upper.color[0] - lower.color[0]) * t;
        gradientCache[off+1] = lower.color[1] + (upper.color[1] - lower.color[1]) * t;
        gradientCache[off+2] = lower.color[2] + (upper.color[2] - lower.color[2]) * t;
        gradientCache[off+3] = lower.color[3] + (upper.color[3] - lower.color[3]) * t;
    }

    if (typeof map !== 'undefined' && rasterId) {
        map.updateRasterLUT(rasterId, gradientCache, GRADIENT_STEPS);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildGradientCache);
} else {
    buildGradientCache();
}

// --- Decompression & Helper ---
async function decompressBlob(compressedBytes) {
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([compressedBytes]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
}

function inverseSpatialDiff(data, width, height) {
    for (let row = 0; row < height; row++) {
        let offset = row * width;
        for (let col = 1; col < width; col++) {
            data[offset + col] += data[offset + col - 1];
        }
    }
    return data;
}

function inverseTemporalDiff(prevData, deltaData) {
    const len = prevData.length;
    const curr = new Int32Array(len);
    for (let i = 0; i < len; i++) curr[i] = prevData[i] + deltaData[i];
    return curr;
}

// --- WebSocket ---
let msgQueue = Promise.resolve();

function connectWebSocket(genId) {
    if (genId !== loadGeneration) return;

    if (typeof model === 'undefined' || typeof run1 === 'undefined' || typeof variable === 'undefined') return;
    
    if (ws) {
        ws.onclose = null; 
        ws.close();
    }

    const dynamicUrl = `ws://${host}:8765/${model}/${run1}/${variable}_${level}`;
    ws = new WebSocket(dynamicUrl);
    ws.binaryType = 'arraybuffer';
    
    ws.onmessage = (e) => {
        totalBytesReceived += e.data.byteLength;
        if(sizeEl) sizeEl.innerText = `${(totalBytesReceived/1024/1024).toFixed(2)} MB`;
        if (statusEl) statusEl.innerText = `Receiving data... (Rx ${frameCount + 1})`;
        msgQueue = msgQueue.then(() => handleMessage(e.data)).catch(console.error);
    };
    
    ws.onclose = () => {
        if (downloadIdleTimer) clearTimeout(downloadIdleTimer);
        if (isPreloadingEnabled && frameCount > 0) scheduleBackgroundGeneration(true); 
        else if (statusEl) statusEl.innerText = "Ready.";

        if (genId === loadGeneration) {
            setTimeout(() => connectWebSocket(genId), 1000);
        }
    };
}

async function handleMessage(buffer) {
    const dv = new DataView(buffer);
    const frameType = dv.getUint8(1);
    const validTime = dv.getUint32(2, true);
    const metaLen = dv.getUint16(6, true);
    
    resetStallTimer();

    let streamMeta = null;
    if (metaLen > 0) {
        streamMeta = JSON.parse(new TextDecoder().decode(buffer.slice(8, 8 + metaLen)));
        if (streamMeta.extent) {
            meta = { 
                EXTENT: streamMeta.extent,
                width: streamMeta.width,
                height: streamMeta.height,
                scale: streamMeta.scale || 100,
                hasAlpha: streamMeta.alpha || false
            };
        }
    }
    
    if (!meta) return;

    const rawBuffer = await decompressBlob(buffer.slice(8 + metaLen));
    
    let maskBytes = null;
    let dataOffset = 0;
    
    if (meta.hasAlpha) {
        const totalPixels = meta.width * meta.height;
        const maskSize = Math.ceil(totalPixels / 8);
        maskBytes = new Uint8Array(rawBuffer, 0, maskSize);
        dataOffset = maskSize;
    }

    const rawInt32 = new Int32Array(rawBuffer.slice(dataOffset));
    let finalInt32;

    if (frameType === FRAME_TYPE_I) {
        finalInt32 = inverseSpatialDiff(rawInt32, meta.width, meta.height);
    } else {
        const deltaInt32 = inverseSpatialDiff(rawInt32, meta.width, meta.height);
        finalInt32 = inverseTemporalDiff(frames[frameCount - 1].quantizedData, deltaInt32);
    }

    frames[frameCount] = {
        quantizedData: finalInt32,
        mask: maskBytes,
        width: meta.width,
        height: meta.height,
        time: validTime,
        cachedFloatBuffer: null
    };

    window.baseFrameCount = frameCount + 1;
    if (typeof updateSliderUI === 'function') updateSliderUI();

    if (isPreloadingEnabled) {
        isGenerating = false;
        if (generationQueueTimer) clearTimeout(generationQueueTimer);
        if (downloadIdleTimer) clearTimeout(downloadIdleTimer);
        downloadIdleTimer = setTimeout(scheduleBackgroundGeneration, 500);
    }

    // --- SWAP LOGIC IS TRIGGERED HERE ---
    // If we receive the frame the user asked for (sticky slider), render it immediately
    if (window.targetFrameIndex !== -1 && frameCount === window.targetFrameIndex) {
        currentFrameIndex = frameCount; 
        renderCanvas(currentFrameIndex); // This will create new raster -> Trigger Swap -> Delete Old
        window.targetFrameIndex = -1;
        clearTimeout(stallTimeout);
    } 
    // Or if we are just starting fresh and user didn't ask for specific frame
    else if (frameCount === 0 || currentFrameIndex === frameCount) { 
        if (window.targetFrameIndex === -1) {
             renderCanvas(currentFrameIndex);
        }
    }

    frameCount++;
}

window.togglePreloading = function() {
    isPreloadingEnabled = !isPreloadingEnabled;
    window.updatePreloadButton(isPreloadingEnabled);
    if (isPreloadingEnabled) scheduleBackgroundGeneration();
    else {
        isGenerating = false;
        if (generationQueueTimer) clearTimeout(generationQueueTimer);
        if (downloadIdleTimer) clearTimeout(downloadIdleTimer);
    }
};

function scheduleBackgroundGeneration(force = false) {
    if (!isPreloadingEnabled && !force) return;
    if (isGenerating && !force) return;
    if (downloadIdleTimer) clearTimeout(downloadIdleTimer);
    if (generationQueueTimer) clearTimeout(generationQueueTimer);
    generationQueueTimer = setTimeout(processNextBackgroundTask, 10);
}

function processNextBackgroundTask() {
    isGenerating = true;
    let targetIdx = -1;
    let framesPreloaded = 0;
    
    for (let i = 0; i < frameCount; i++) {
        if (frames[i].cachedFloatBuffer) framesPreloaded++;
        else if (targetIdx === -1 && i >= currentFrameIndex) targetIdx = i;
    }

    if (targetIdx === -1) {
        for (let i = 0; i < currentFrameIndex; i++) {
             if (frames[i] && !frames[i].cachedFloatBuffer) {
                targetIdx = i;
                break;
            }
        }
    }
    
    const totalFrames = Math.max(1, frameCount);
    const progress = Math.min(100, Math.floor((framesPreloaded / totalFrames) * 100));

    if (targetIdx !== -1) {
        if (statusEl) statusEl.innerText = `Preloading GPU buffers: ${progress}% (${framesPreloaded}/${totalFrames})`;
        ensureFrameBuffer(frames[targetIdx]);
        setTimeout(processNextBackgroundTask, 0); 
    } else {
        isGenerating = false;
        if (statusEl) statusEl.innerText = `Ready. All frames preloaded.`;
    }
}

function ensureFrameBuffer(f) {
    if (f.cachedFloatBuffer || !meta) return;

    const qData = f.quantizedData;
    const mask = f.mask;
    const len = qData.length;
    const scale = meta.scale;
    
    const buffer = new Float32Array(len * 2);
    for (let i = 0; i < len; i++) {
        const val = qData[i] / scale;
        let isVisible = 1.0;
        if (mask) {
            const byteIndex = i >>> 3; 
            const bitIndex = 7 - (i & 7); 
            isVisible = ((mask[byteIndex] >> bitIndex) & 1) ? 1.0 : 0.0;
        }
        const off = i * 2;
        buffer[off] = val;
        buffer[off + 1] = isVisible;
    }
    f.cachedFloatBuffer = buffer;
}

function resetStallTimer() {
    if (stallTimeout) clearTimeout(stallTimeout);
    if (window.targetFrameIndex !== -1) {
        stallTimeout = setTimeout(() => {
            console.warn("Stream stalled. Snapping back.");
            window.targetFrameIndex = -1;
            const lastAvailable = Math.max(0, frameCount - 1);
            const slider = document.getElementById('timeSlider');
            if (slider) slider.value = lastAvailable;
            currentFrameIndex = lastAvailable;
            renderCanvas(currentFrameIndex);
        }, STALL_THRESHOLD);
        
        if (statusEl) statusEl.innerText = `Waiting for Frame ${window.targetFrameIndex}...`;
    }
}

// --- Renderer ---
function renderCanvas(frameIdx) {
    if (!frames[frameIdx] || !meta) return;
    const f = frames[frameIdx];

    // UPDATED: Use helper to format time based on toggle
    if (f.time && timeDisplay) {
        timeDisplay.innerText = getFormattedTime(f.time);
    }

    if (!f.cachedFloatBuffer) {
        ensureFrameBuffer(f);
    }

    // 1. If no active raster, create one (This happens when we finally render the target frame)
    if (typeof map !== 'undefined' && !rasterId && meta.EXTENT) {
        rasterId = map.addRaster(meta.EXTENT, f.width, f.height);
        map.updateRasterLUT(rasterId, gradientCache, GRADIENT_STEPS);
        map.updateRasterParams(rasterId, lutMin, lutMax);
    } 
    
    // 2. Update Data
    if (map && rasterId && f.cachedFloatBuffer) {
        map.updateRasterData(rasterId, f.cachedFloatBuffer, f.width, f.height);
    }

    // 3. --- EXECUTE SWAP ---
    // Now that the new raster has data and is rendering, we can safely delete the old one.
    if (previousRasterId && typeof map !== 'undefined') {
        map.removeRaster(previousRasterId);
        previousRasterId = null;
    }
    
    if (typeof map !== 'undefined' && map.state.hover.active) {
        updateHoverData(map.state.hover.sx, map.state.hover.sy);
        map.refreshTooltipAtLastPosition();
    }
    
    if (isGenerating && statusEl) {
        const totalFrames = Math.max(1, frameCount);
        let framesPreloaded = 0;
        for (let i = 0; i < frameCount; i++) {
             if (frames[i].cachedFloatBuffer) framesPreloaded++;
        }
        const progress = Math.min(100, Math.floor((framesPreloaded / totalFrames) * 100));
        statusEl.innerText = `Preloading GPU buffers: ${progress}% (${framesPreloaded}/${totalFrames})`;
    } else if (!isGenerating && frameCount > 0) {
        if (statusEl && !statusEl.innerText.startsWith('Receiving') && !statusEl.innerText.startsWith('Waiting')) {
            statusEl.innerText = isPreloadingEnabled ? `Ready. All frames preloaded.` : `Ready. Preloading disabled.`;
        }
    }
}

function convertValue(val) {
    if (!currentUnit || !sourceUnit || currentUnit === sourceUnit) return val;
    if (!window.globalUnitConfig || !window.globalUnitConfig.conversions) return val;
    const convList = window.globalUnitConfig.conversions[sourceUnit];
    if (!convList) return val;
    const targetConv = convList.find(c => c.target_unit === currentUnit);
    if (!targetConv) return val;
    try {
        const mathBody = "return " + targetConv.formula.replace('{x}', 'val');
        const func = new Function('val', mathBody);
        return func(val);
    } catch (e) { console.error("Conversion error", e); return val; }
}

function updateHoverData(clientX, clientY) {
    if(!frames[currentFrameIndex] || !map) return;
    const pi = map.getRasterPixelAt(clientX, clientY);
    if(pi) {
        const idx = pi.y * pi.width + pi.x;
        const f = frames[currentFrameIndex];
        let hoverText = "No Data"; 
        if(f.mask) {
            const isVis = (f.mask[idx >>> 3] >> (7 - (idx & 7))) & 1;
            if(!isVis) { map.updateHoverValue("No Data"); return; }
        }
        if(f.quantizedData[idx] !== undefined) {
            const rawVal = f.quantizedData[idx] / (meta.scale||100);
            const finalVal = convertValue(rawVal);
            let unitLabel = currentUnit || "";
            if (window.globalUnitConfig && window.globalUnitConfig.display_units) {
                unitLabel = window.globalUnitConfig.display_units[currentUnit] || currentUnit;
            }
            hoverText = `${finalVal.toFixed(2)} ${unitLabel}`;
        }
        if(map.updateHoverValue) map.updateHoverValue(hoverText);
    } else {
        if(map.updateHoverValue) map.updateHoverValue("No Data");
    }
}

function setupUnits(uiConfig) {
    if (!uiConfig) return;
    sourceUnit = uiConfig.default_unit;
    const available = uiConfig.available_units || [];
    const select = document.getElementById('unitSelect');
    const container = document.getElementById('unitSettingRow');
    if (!select || !container) return;
    select.innerHTML = '';
    if (!available || available.length === 0) {
        container.style.display = 'none';
        currentUnit = sourceUnit;
        return;
    }
    container.style.display = 'flex';
    available.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u;
        let label = u;
        if (window.globalUnitConfig && window.globalUnitConfig.display_units) {
            label = window.globalUnitConfig.display_units[u] || u;
        }
        opt.textContent = label;
        select.appendChild(opt);
    });
    const def = uiConfig.default_unit || sourceUnit;
    select.value = def;
    currentUnit = def;
    select.onchange = (e) => {
        currentUnit = e.target.value;
        if (map && map.state.hover.active) {
             updateHoverData(map.state.hover.sx, map.state.hover.sy);
             map.refreshTooltipAtLastPosition();
        }
    };
}

// --- Init & Reload (Updated to respect Preloading state) ---
window.reloadImagesPrepare = async function() {
    const myGen = ++loadGeneration;
    if (ws) { ws.close(); ws = null; }
    
    isGenerating = false;
    if (generationQueueTimer) clearTimeout(generationQueueTimer);
    if (downloadIdleTimer) clearTimeout(downloadIdleTimer);

    if (statusEl) statusEl.innerText = "Initializing connection...";

    const slider = document.getElementById('timeSlider');
    if (slider) {
        const val = parseInt(slider.value);
        if (val > 0) {
            // LOCK: We found a value, lock it in.
            window.targetFrameIndex = val;
            resetStallTimer(); 
        } else {
            window.targetFrameIndex = -1;
        }
    }

    const p = new URLSearchParams(window.location.search);
    variable = p.get('variable') || variable;
    level = p.get('level') || level;
    model = p.get('model') || model;
    
    if (request == "radar"){
        const ind = document.getElementById("layerIndicator");
        if(ind) ind.innerHTML = variable + " (" + level + ")";
    } else {
        const menuLink = document.getElementById(variable);
        const ind = document.getElementById("layerIndicator");
        if(ind) ind.innerHTML = menuLink ? menuLink.innerHTML : variable;
    }

    // --- CRITICAL CHANGE: PRESERVE OLD RASTER ---
    // Instead of removing it now, move it to 'previousRasterId'
    // It will be removed inside renderCanvas once the new frame is ready.
    if (rasterId) {
        // If we had a REALLY old one pending, clear it now to prevent buildup
        if (previousRasterId && typeof map !== 'undefined') map.removeRaster(previousRasterId);
        previousRasterId = rasterId;
    }
    rasterId = null; // Reset current ID so we build a new one

    frames = []; frameCount = 0; totalBytesReceived = 0; 
    currentFrameIndex = 0; meta = null;
    
    try {
        const confRes = await fetch(`scripts/getUiConfig.php?variable=${variable}&level=${level}`);
        if (loadGeneration !== myGen) return;
        const conf = await confRes.json();
        setupUnits(conf);
        
        // --- FIX START: Update Colormap Label Text ---
        const cmapName = conf.default_colormap || 'default';
        const cmapLabel = document.getElementById('colormapVariable');
        if (cmapLabel) cmapLabel.innerText = cmapName;
        // --- FIX END ---
        
        const cmapRes = await fetch(`config/colormaps/${cmapName}.txt`);
        if (loadGeneration !== myGen) return; 
        colorTable = await cmapRes.json();
        buildGradientCache();
        if (typeof initColormapLegend === 'function') initColormapLegend();
    } catch(e) { console.error("Config fetch failed", e); }

    connectWebSocket(myGen);
}

function initStream() {
    timeDisplay = document.getElementById('timeDisplay');
    statusEl = document.getElementById('status');
    sizeEl = document.getElementById('sizeDisplay');
    const sl = document.getElementById('timeSlider');
    
    // UPDATED: Add Click Handler for toggling UTC/Local
    if (timeDisplay) {
        timeDisplay.style.cursor = 'pointer';
        timeDisplay.title = "Click to toggle between UTC and Local time";
        timeDisplay.addEventListener('click', () => {
            useLocalTime = !useLocalTime;
            // Immediate update if we have the current frame data
            if (frames[currentFrameIndex] && frames[currentFrameIndex].time) {
                timeDisplay.innerText = getFormattedTime(frames[currentFrameIndex].time);
            }
        });
    }
    
    // User Interaction Listener
    if(sl) {
        let renderReq = null;
        sl.addEventListener('input', () => {
            // USER INTERACTION: If user touches slider, we cancel the "Wait/Lock" state
            window.targetFrameIndex = -1; 
            clearTimeout(stallTimeout);
            
            if (renderReq) cancelAnimationFrame(renderReq);
            renderReq = requestAnimationFrame(() => {
                const val = parseInt(sl.value);
                const maxSafe = Math.max(0, frameCount - 1);
                currentFrameIndex = Math.min(val, maxSafe);
                renderCanvas(currentFrameIndex);
            });
        });
    }
    
    const con = document.getElementById('container');
    if(con) con.addEventListener('mousemove', e => {
        updateHoverData(e.clientX, e.clientY);
    });
    if (window.initialUiConfig) setupUnits(window.initialUiConfig);
    if (statusEl) statusEl.innerText = "Waiting for connection...";
    connectWebSocket(loadGeneration);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initStream);
else initStream();