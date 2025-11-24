// --- Constants ---
const WS_URL = 'ws://localhost:8765/HRRR/1763989200/GUST_0-SFC';
const STREAM_BASE = 0x00;
const STREAM_DETAIL = 0x01;

// --- State ---
let frames = []; 
let meta = null; 
let currentFrameIndex = 0;
let baseFrameCount = 0;
let detailFrameCount = 0; 

const slider = document.getElementById('timeSlider');
const status = document.getElementById('status');
const hoverBox = document.getElementById('hoverValue');
const timeDisplay = document.getElementById('timeDisplay');

// --- Helpers ---
const fv = new DataView(new ArrayBuffer(4));
function decodeMetaFloat(r, g, b) {
    const s = (r >> 7) & 0x1;
    const e = (r & 0x7F) + 64;
    const m = (g << 8) | b;
    fv.setInt32(0, (s << 31) | (e << 23) | (m << 7));
    return fv.getFloat32(0);
}

// --- WEBSOCKET LOGIC ---
let msgQueue = Promise.resolve();

function connectWebSocket() {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => status.innerText = "Connected. Waiting for stream...";
    ws.onclose = () => {
        status.innerText = "Disconnected. Reconnecting...";
        setTimeout(connectWebSocket, 1000); 
    };
    ws.onerror = (e) => console.error("WS Error", e);

    ws.onmessage = (event) => {
        msgQueue = msgQueue.then(async () => {
            await handleMessage(event.data);
        }).catch(err => console.error("Error processing message:", err));
    };
}

async function handleMessage(buffer) {
    const dv = new DataView(buffer);
    const streamId = dv.getUint8(0);
    const frameType = dv.getUint8(1);
    const payload = buffer.slice(2);

    if (streamId === STREAM_BASE) await processBaseFrame(frameType, payload);
    else if (streamId === STREAM_DETAIL) await processDetailFrame(frameType, payload);
}

async function processBaseFrame(frameType, rawPayload) {
    const dv = new DataView(rawPayload);
    const validTime = dv.getUint32(0, true);
    const data = rawPayload.slice(4);

    if (frameType === 0x00) { // I-Frame
        const bitmap = await createImageBitmap(new Blob([data], {type: 'image/webp'}));
        
        const tempCv = document.createElement('canvas');
        tempCv.width = bitmap.width; tempCv.height = bitmap.height;
        const tempCtx = tempCv.getContext('2d');
        tempCtx.drawImage(bitmap, 0, 0);
        const pData = tempCtx.getImageData(0, 0, bitmap.width, bitmap.height).data;

        if (baseFrameCount === 0) {
            meta = {
                MIN: decodeMetaFloat(pData[0], pData[1], pData[2]),
                RANGE: decodeMetaFloat(pData[4], pData[5], pData[6]),
                RES_MIN: decodeMetaFloat(pData[8], pData[9], pData[10]),
                RES_RANGE: decodeMetaFloat(pData[12], pData[13], pData[14])
            };
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
        }
        
        const baseLayer = new Uint8Array(bitmap.width * bitmap.height);
        const alphaLayer = new Uint8Array(bitmap.width * bitmap.height);
        
        for(let i=0; i<baseLayer.length; i++) {
            baseLayer[i] = pData[i*4];
            alphaLayer[i] = pData[i*4+3];
        }
        
        frames[baseFrameCount] = { 
            base: baseLayer, alpha: alphaLayer,
            residual: new Uint16Array(baseLayer.length).fill(32768),
            width: bitmap.width, height: bitmap.height,
            time: validTime,
            cachedData: null // Initialize cache slot
        };
    } 
    else if (frameType === 0x01) { // P-Frame
        const ds = new DecompressionStream('gzip');
        const rawDelta = await new Response(new Response(data).body.pipeThrough(ds)).arrayBuffer();
        const delta = new Int16Array(rawDelta);
        const prev = frames[baseFrameCount-1];
        
        if (prev && prev.base) {
            const curr = new Uint8Array(prev.base.length);
            const prevBase = prev.base;
            for(let i=0; i<curr.length; i++) curr[i] = prevBase[i] + delta[i];
            
            frames[baseFrameCount] = { 
                base: curr, alpha: prev.alpha,
                residual: new Uint16Array(curr.length).fill(32768),
                width: frames[0].width, height: frames[0].height,
                time: validTime,
                cachedData: null
            };
        }
    }

    slider.max = baseFrameCount;
    slider.disabled = false;
    const dateStr = new Date(validTime * 1000).toUTCString().split(' ')[4];
    status.innerText = `Rx Frame ${baseFrameCount} (${dateStr} UTC)`;
    
    if (baseFrameCount === 1 || currentFrameIndex === baseFrameCount) {
        renderCanvas(currentFrameIndex);
    }
    baseFrameCount++;
}

async function processDetailFrame(frameType, rawPayload) {
    const idx = detailFrameCount;
    const data = rawPayload.slice(4);

    if (frameType === 0x00) { // I-Frame
         const bitmap = await createImageBitmap(new Blob([data], {type: 'image/webp'}));
         const tempCv = document.createElement('canvas');
         tempCv.width = bitmap.width; tempCv.height = bitmap.height;
         const tempCtx = tempCv.getContext('2d');
         tempCtx.drawImage(bitmap, 0, 0);
         const pData = tempCtx.getImageData(0, 0, bitmap.width, bitmap.height).data;
         
         if (frames[idx]) {
             const resLayer = frames[idx].residual;
             for(let i=0; i<resLayer.length; i++) {
                 resLayer[i] = (pData[i*4] << 8) | pData[i*4+1];
             }
             // Invalidate cache because residual changed
             frames[idx].cachedData = null; 
             if (currentFrameIndex === idx) renderCanvas(idx);
         }
    } 
    else if (frameType === 0x01) { // P-Frame
        const ds = new DecompressionStream('gzip');
        const rawDelta = await new Response(new Response(data).body.pipeThrough(ds)).arrayBuffer();
        const delta = new Int32Array(rawDelta);

        if (frames[idx]) {
            const prevRes = frames[idx-1]?.residual;
            const currRes = frames[idx].residual;
            if (prevRes) {
                for(let i=0; i<currRes.length; i++) currRes[i] = prevRes[i] + delta[i];
            }
            // Invalidate cache
            frames[idx].cachedData = null;
            if (currentFrameIndex === idx) renderCanvas(idx);
        }
    }
    detailFrameCount++;
}

// --- RENDERER ---
function renderCanvas(frameIdx) {
    if (!frames[frameIdx] || !meta) return;
    const f = frames[frameIdx];

    // Update Time Display
    if (f.time) {
        timeDisplay.innerText = new Date(f.time * 1000).toUTCString().replace(":00 GMT", " UTC");
    }

    // Optimization: Use Cached Image Data if available
    if (f.cachedData) {
        ctx.putImageData(f.cachedData, 0, 0);
    } else {
        // If not cached, calculate math and colors
        const imgData = ctx.createImageData(f.width, f.height);
        const d = imgData.data;
        const { MIN, RANGE, RES_MIN, RES_RANGE } = meta;
        const baseFactor = RANGE / 255.0;
        const resFactor = RES_RANGE / 65535.0;

        const len = f.base.length;
        
        // Inline variables for speed
        let baseVal, resVal, finalVal, t, tc, r, g, b;

        for (let i = 0; i < len; i++) {
            const alpha = f.alpha[i];
            if (alpha === 0) {
                d[i*4+3] = 0;
                continue;
            }

            baseVal = f.base[i] * baseFactor + MIN;
            resVal = f.residual[i] * resFactor + RES_MIN;
            finalVal = baseVal + resVal;
            
            // Normalize t
            t = (finalVal - MIN) / RANGE;
            
            // INLINED Color Logic (Removed function call overhead)
            tc = t < 0 ? 0 : (t > 1 ? 1 : t); // Clamp
            if(tc < 0.5) { 
                b = 255 * (1 - tc*2); 
                g = 255 * tc*2; 
                r = 0;
            } else { 
                g = 255 * (1 - (tc-0.5)*2); 
                r = 255 * (tc-0.5)*2; 
                b = 0;
            }
            
            d[i*4] = r; 
            d[i*4+1] = g; 
            d[i*4+2] = b; 
            d[i*4+3] = alpha;
        }
        
        // Save to Cache
        f.cachedData = imgData;
        ctx.putImageData(imgData, 0, 0);
    }

    // OPTIMIZATION: Texture Reuse
    // If layer doesn't exist, add it. If it does, just update the texture.
    if (!rasterId) {
        rasterId = map.addRaster(canvas, [-134.12142793280148, 21.14706163554821, -60.92779791187436, 52.62870288555903]);
    } else {
        map.updateRaster(rasterId);
    }
}

slider.addEventListener('input', (e) => {
    // Use requestAnimationFrame to prevent UI blocking during rapid sliding
    requestAnimationFrame(() => {
        currentFrameIndex = parseInt(e.target.value);
        renderCanvas(currentFrameIndex);
    });
});

canvas.addEventListener('mousemove', (e) => {
    if (!frames[currentFrameIndex]) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
    const idx = y * canvas.width + x;
    const f = frames[currentFrameIndex];
    
    if (idx >= 0 && idx < f.base.length) {
        if (f.alpha[idx] === 0) {
            hoverBox.innerText = "No Data";
            return;
        }
        const { MIN, RANGE, RES_MIN, RES_RANGE } = meta;
        const baseVal = f.base[idx] * (RANGE / 255.0) + MIN;
        const resVal = f.residual[idx] * (RES_RANGE / 65535.0) + RES_MIN;
        hoverBox.innerText = (baseVal + resVal).toFixed(4);
    }
});

connectWebSocket();