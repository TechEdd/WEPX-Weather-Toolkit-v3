class AdaptiveMap {
    constructor(containerId, tooltipId) {
        this.container = document.getElementById(containerId);
        this.tooltip = document.getElementById(tooltipId);
        this.overlays = []; // 2D DOM Overlays
        this.layers = [];   // Vector Layers
        this.rasters = [];  // WebGL Raster Layers (Heatmaps)
        this.callbacks = []; 
        
        this._idCounter = 0;

        // UI Settings State
        this.ui = {
            projection: 'cylindrical',
            interpolation: 'linear', // 'linear' (smooth) or 'nearest' (pixelated)
            tooltipEnabled: true,
            tooltipMode: 'follow', // 'follow' or 'fixed'
            darkMode: false,
            showLatLon: true,
            showValue: true,
            currentHoverValue: null 
        };

        this.state = {
            morph: 0.0, targetMorph: 0.0, zoom: 0.5,
            pan: { x: 0, y: 0 },
            width: this.container.clientWidth,
            height: this.container.clientHeight,
            mouse: { x: 0, y: 0, down: false, lastX: 0, lastY: 0 },
            // Store hover state to fix data lag
            hover: { sx: 0, sy: 0, wx: 0, wy: 0, active: false }
        };

        this.canvas = document.createElement('canvas');
        this.container.appendChild(this.canvas);
        this.gl = this.canvas.getContext('webgl', { antialias: true, alpha: true });

        if (!this.gl) throw new Error("WebGL not supported");

        // --- ENABLE FLOAT TEXTURES (Critical for Data) ---
        // We need OES_texture_float to store raw weather values in the texture
        const extFloat = this.gl.getExtension('OES_texture_float');
        const extLinear = this.gl.getExtension('OES_texture_float_linear'); // Optional but nice
        if (!extFloat) console.warn("WebGL Float Textures not supported. Rendering artifacts may occur.");
		
		this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        
        // Initial Background Color: #EEE equivalent (Light Mode default)
		this.backgroundColor = [0.933, 0.933, 0.933, 1.0];

        this._initShaders();
        this._initEvents();
        this._resize();
        requestAnimationFrame((t) => this._render(t));
    }

    // --- Public Coordinate Logic ---

    getRasterPixelAt(clientX, clientY) {
        if (this.rasters.length === 0) return null;

        // 1. Normalize Coordinates to Canvas Space
        const rect = this.canvas.getBoundingClientRect();
        const screenX = clientX - rect.left;
        const screenY = clientY - rect.top;

        // 2. Convert Screen -> NDC -> World Coordinates (Radians)
        const ndcX = (screenX / this.state.width) * 2 - 1;
        const ndcY = -((screenY / this.state.height) * 2 - 1); // Inverted Y

        const aspect = this.state.width / this.state.height;
        
        const clipX = ndcX * aspect;
        const clipY = ndcY;

        const worldX = (clipX - this.state.pan.x) / this.state.zoom;
        const worldY = (clipY - this.state.pan.y) / this.state.zoom;

        // 3. Inverse Projection (World -> Lat/Lon)
        const lonRad = worldX;

        // WorldY is mixed: (1-m)*lat + m*ln(tan(pi/4 + lat/2))
        let latRad = worldY; // Initial guess
        const m = this.state.morph;
        const PI = Math.PI;
        
        // Newton-Raphson iteration
        for (let i = 0; i < 5; i++) {
            const mercY = Math.log(Math.tan((PI / 4) + (latRad / 2)));
            const val = (1 - m) * latRad + m * mercY - worldY;
            const deriv = (1 - m) + m * (1 / Math.cos(latRad));
            const delta = val / deriv;
            latRad -= delta;
            if (Math.abs(delta) < 1e-6) break;
        }

        if (latRad < -1.5) latRad = -1.5; 
        if (latRad > 1.5) latRad = 1.5;

        // 4. Map Lat/Lon to Raster UV
        const raster = this.rasters[0]; 
        const { minLon, minLat, lonRange, latRange, width, height } = raster.meta;

        const u = (lonRad - minLon) / lonRange;
        const v = (latRad - minLat) / latRange;

        // 5. Check Bounds (0-1)
        if (u < 0 || u > 1 || v < 0 || v > 1) return null;

        // 6. Convert to Pixel Coordinates (Clamped)
        let px = Math.floor(u * width);
        let py = Math.floor((1 - v) * height);

        // Clamp to ensure we never go out of bounds (0 to width-1)
        px = Math.max(0, Math.min(px, width - 1));
        py = Math.max(0, Math.min(py, height - 1));

        return { x: px, y: py, width, height };
    }

    // --- Public UI API ---
    toggleProjection() {
        this.state.targetMorph = this.state.targetMorph < 0.5 ? 1.0 : 0.0;
        this.ui.projection = this.state.targetMorph > 0.5 ? 'mercator' : 'cylindrical';
        const btn = document.getElementById('btnProj');
        if (btn) btn.innerText = `Projection: ${this.ui.projection.charAt(0).toUpperCase() + this.ui.projection.slice(1)}`;
    }

    toggleTooltipState() {
        this.ui.tooltipEnabled = !this.ui.tooltipEnabled;
        if (!this.ui.tooltipEnabled && this.tooltip) this.tooltip.style.display = 'none';
        const btn = document.getElementById('btnTooltipState');
        if (btn) btn.innerText = `Tooltip: ${this.ui.tooltipEnabled ? 'Enabled' : 'Disabled'}`;
    }

    toggleTooltipMode() {
        this.ui.tooltipMode = this.ui.tooltipMode === 'follow' ? 'fixed' : 'follow';
        const btn = document.getElementById('btnTooltipMode');
        if (btn) btn.innerText = `Mode: ${this.ui.tooltipMode === 'follow' ? 'Follow Mouse' : 'Fixed Pos'}`;
        
        if (this.tooltip) {
            if (this.ui.tooltipMode === 'fixed') {
                this.tooltip.classList.add('fixed-mode');
                this.tooltip.style.left = '';
                this.tooltip.style.top = '';
                this.tooltip.style.display = 'block';
            } else {
                this.tooltip.classList.remove('fixed-mode');
            }
        }
    }

    toggleInterpolation() {
        this.ui.interpolation = this.ui.interpolation === 'linear' ? 'nearest' : 'linear';
        const btn = document.getElementById('btnInterpolation');
        if (btn) btn.innerText = `Smoothing: ${this.ui.interpolation === 'linear' ? 'On' : 'Off'}`;

        const gl = this.gl;
        const filter = this.ui.interpolation === 'linear' ? gl.LINEAR : gl.NEAREST;

        // Immediately apply to all existing rasters
        this.rasters.forEach(r => {
            gl.bindTexture(gl.TEXTURE_2D, r.dataTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        });
    }

    toggleLatLon(isChecked) {
        this.ui.showLatLon = isChecked;
    }

    toggleValue(isChecked) {
        this.ui.showValue = isChecked;
    }

    updateHoverValue(text) {
        this.ui.currentHoverValue = text;
        // Immediate refresh using stored coordinates to prevent lag
        if (this.state.hover.active && this.ui.tooltipEnabled) {
            this._updateTooltip(
                this.state.hover.sx, 
                this.state.hover.sy, 
                this.state.hover.wx, 
                this.state.hover.wy
            );
        }
    }

    refreshTooltipAtLastPosition() {
        if (this.state.hover.active) {
            this._updateTooltip(this.state.hover.sx, this.state.hover.sy, this.state.hover.wx, this.state.hover.wy);
        }
    }

    toggleDarkMode() {
        this.ui.darkMode = !this.ui.darkMode;
        const btn = document.getElementById('btnDarkMode');
        if (btn) btn.innerText = `Dark Mode: ${this.ui.darkMode ? 'On' : 'Off'}`;
        
        if (this.ui.darkMode) {
            this.backgroundColor = [0.05, 0.05, 0.05, 1];
            this.layers.forEach(l => l.color = [0.9, 0.9, 0.9, 0.9]);
        } else {
            this.backgroundColor = [0.9, 0.9, 0.9, 0.9];
            this.layers.forEach(l => l.color = [0.1, 0.1, 0.1, 0.9]);
        }
    }

    // --- 1. DOM Overlay System ---
    addCanvas(canvasObj, boundingBox = null) {
        const id = `canvas_${this._idCounter++}`;
        canvasObj.id = id; 
        canvasObj.style.position = 'absolute';
        canvasObj.style.top = '0'; canvasObj.style.left = '0';
        canvasObj.style.width = '100%'; canvasObj.style.height = '100%';
        canvasObj.style.pointerEvents = 'none';
        this.container.appendChild(canvasObj);
        this.overlays.push({ id, element: canvasObj, bounds: boundingBox }); 
        this._resizeCanvas(canvasObj);
        return id;
    }

    // --- 2. WebGL Raster System (GPU Accelerated) ---
    
    // Create the Raster Layer (Buffers + Textures)
    addRaster(bbox, width, height) {
        const id = `raster_${this._idCounter++}`;
        const gl = this.gl;
        const DEG2RAD = Math.PI / 180;

        const cols = 64, rows = 32;
        const pos = [], uv = [], ind = [];
        const minLon = bbox[0] * DEG2RAD;
        const minLat = bbox[1] * DEG2RAD;
        const maxLon = bbox[2] * DEG2RAD;
        const maxLat = bbox[3] * DEG2RAD;
        const lonRange = maxLon - minLon;
        const latRange = maxLat - minLat;

        for (let y = 0; y <= rows; y++) {
            for (let x = 0; x <= cols; x++) {
                const u = x / cols; 
                const v = y / rows;
                uv.push(u, 1.0 - v); 
                pos.push(minLon + (u * lonRange), minLat + (v * latRange));
            }
        }

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const a = y * (cols + 1) + x, b = a + 1, c = a + (cols + 1), d = c + 1;
                ind.push(a, b, c, b, d, c);
            }
        }

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);

        const uvBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);

        const indBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ind), gl.STATIC_DRAW);

        // Determine filter based on current setting
        const filter = this.ui.interpolation === 'linear' ? gl.LINEAR : gl.NEAREST;

        // --- A. Data Texture (Float, Luminance+Alpha) ---
        // L: Value, A: Mask
        const dataTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, dataTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        // Initialize with null data
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, width, height, 0, gl.LUMINANCE_ALPHA, gl.FLOAT, null);

        // --- B. LUT Texture (RGBA) ---
        // LUT usually stays LINEAR for smooth color gradients
        const lutTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, lutTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        this.rasters.push({
            id, 
            dataTexture, 
            lutTexture,
            posBuffer, uvBuffer, indBuffer, count: ind.length,
            opacity: 1,
            dataMin: 0, 
            dataMax: 1,
            // Store Metadata for Inverse Projection
            meta: { 
                minLon, minLat, maxLon, maxLat, lonRange, latRange,
                width, height
            }
        });

        return id;
    }

    removeRaster(id) {
        const index = this.rasters.findIndex(r => r.id === id);
        if (index !== -1) {
            const r = this.rasters[index];
            this.gl.deleteTexture(r.dataTexture);
            this.gl.deleteTexture(r.lutTexture);
            this.gl.deleteBuffer(r.posBuffer);
            this.gl.deleteBuffer(r.uvBuffer);
            this.gl.deleteBuffer(r.indBuffer);
            this.rasters.splice(index, 1);
        }
    }

    // Update the Raw Data (Float Buffer)
    // floatBuffer must be interleaved [Val, Mask, Val, Mask...] if using LUMINANCE_ALPHA
    updateRasterData(id, floatBuffer, width, height) {
        const layer = this.rasters.find(r => r.id === id);
        if (layer) {
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, layer.dataTexture);
            // Upload Float Data
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, width, height, 0, gl.LUMINANCE_ALPHA, gl.FLOAT, floatBuffer);
            layer.meta.width = width;
            layer.meta.height = height;
        }
    }

    // Update the Gradient (LUT) - Usually called once or on colormap change
    updateRasterLUT(id, lutBuffer, steps) {
        const layer = this.rasters.find(r => r.id === id);
        if (layer) {
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, layer.lutTexture);
            // 1D Texture (Height = 1)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, steps, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutBuffer);
        }
    }

    // Update Uniforms (Contrast) - Instant
    updateRasterParams(id, min, max) {
        const layer = this.rasters.find(r => r.id === id);
        if (layer) {
            layer.dataMin = min;
            layer.dataMax = max;
        }
    }

    // --- 3. Vector Layer System ---
    async addLayer(url, objectName, color = [0.0, 0.0, 0.0, 1.0]) {
        const id = `layer_${this._idCounter++}`;
        try {
            const st = document.getElementById('status');
            if (st) st.innerText = `Loading ${objectName}...`;
            
            const response = await fetch(url);
            const topology = await response.json();
            const geojson = topojson.feature(topology, topology.objects[objectName]);
            
            const points = [];
            const DEG2RAD = Math.PI / 180;

            geojson.features.forEach(feature => {
                const geometry = feature.geometry;
                const processRing = (ring) => {
                    for (let i = 0; i < ring.length - 1; i++) {
                        const p1 = ring[i]; const p2 = ring[i+1];
                        if (Math.abs(p1[0] - p2[0]) > 180) continue; 
                        points.push(p1[0] * DEG2RAD, p1[1] * DEG2RAD);
                        points.push(p2[0] * DEG2RAD, p2[1] * DEG2RAD);
                    }
                };
                if (geometry.type === "Polygon") geometry.coordinates.forEach(processRing);
                else if (geometry.type === "MultiPolygon") geometry.coordinates.forEach(poly => poly.forEach(processRing));
            });

            const buffer = this.gl.createBuffer();
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
            this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(points), this.gl.STATIC_DRAW);

            this.layers.push({ id, buffer, count: points.length / 2, color });
            if (st) st.innerText = `Ready.`;
            return id;
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    removeLayer(id) {
        const index = this.layers.findIndex(l => l.id === id);
        if (index !== -1) {
            this.gl.deleteBuffer(this.layers[index].buffer);
            this.layers.splice(index, 1);
        }
    }

    // --- Core Engine ---
    
    onRender(callback) { this.callbacks.push(callback); }

    _resizeCanvas(canv) { 
        canv.width = this.state.width; canv.height = this.state.height; 
    }

    _resize() {
        this.state.width = this.container.clientWidth;
        this.state.height = this.container.clientHeight;
        this.canvas.width = this.state.width; this.canvas.height = this.state.height;
        this.gl.viewport(0, 0, this.state.width, this.state.height);
        this.overlays.forEach(o => this._resizeCanvas(o.element));
    }

    _initShaders() {
        const vsSource = document.getElementById('vertex-shader').innerText;
        const fsSource = document.getElementById('fragment-shader').innerText;
        const compile = (type, src) => {
            const s = this.gl.createShader(type);
            this.gl.shaderSource(s, src);
            this.gl.compileShader(s);
            if (!this.gl.getShaderParameter(s, this.gl.COMPILE_STATUS)) console.error(this.gl.getShaderInfoLog(s));
            return s;
        };
        const vs = compile(this.gl.VERTEX_SHADER, vsSource);
        const fs = compile(this.gl.FRAGMENT_SHADER, fsSource);
        this.program = this.gl.createProgram();
        this.gl.attachShader(this.program, vs);
        this.gl.attachShader(this.program, fs);
        this.gl.linkProgram(this.program);
        this.gl.useProgram(this.program);

        this.locs = {
            morph: this.gl.getUniformLocation(this.program, 'u_morph'),
            scale: this.gl.getUniformLocation(this.program, 'u_scale'),
            offset: this.gl.getUniformLocation(this.program, 'u_offset'),
            resolution: this.gl.getUniformLocation(this.program, 'u_resolution'),
            isRaster: this.gl.getUniformLocation(this.program, 'u_isRaster'),
            opacity: this.gl.getUniformLocation(this.program, 'u_opacity'),
            color: this.gl.getUniformLocation(this.program, 'u_color'), 
            
            // New Texture Uniforms
            dataTexture: this.gl.getUniformLocation(this.program, 'u_dataTexture'),
            lutTexture: this.gl.getUniformLocation(this.program, 'u_lutTexture'),
            dataMin: this.gl.getUniformLocation(this.program, 'u_dataMin'),
            dataMax: this.gl.getUniformLocation(this.program, 'u_dataMax'),

            pos: this.gl.getAttribLocation(this.program, 'a_position'),
            uv: this.gl.getAttribLocation(this.program, 'a_uv')
        };
        this.gl.enableVertexAttribArray(this.locs.pos);
    }

	_initEvents() {
        // Updated to use client coordinates properly
        const getScreenToWorld = (clientX, clientY) => {
            const rect = this.canvas.getBoundingClientRect();
            const sx = clientX - rect.left;
            const sy = clientY - rect.top;
            
            const aspect = this.state.width / this.state.height;
            const normX = (sx / this.state.width) * 2 - 1;
            const normY = -((sy / this.state.height) * 2 - 1);
            return {
                x: (normX * aspect - this.state.pan.x) / this.state.zoom,
                y: (normY - this.state.pan.y) / this.state.zoom,
                clipX: normX * aspect, clipY: normY
            };
        };

        // --- MOUSE EVENTS ---
        this.container.addEventListener('mousedown', e => {
            this.state.mouse.down = true;
            this.state.mouse.lastX = e.clientX; 
            this.state.mouse.lastY = e.clientY;
        });

        window.addEventListener('mouseup', () => this.state.mouse.down = false);

        this.container.addEventListener('mousemove', e => {
            // 1. Pan Logic
            if (this.state.mouse.down) {
                const dx = e.clientX - this.state.mouse.lastX;
                const dy = e.clientY - this.state.mouse.lastY;
                const aspect = this.state.width / this.state.height;
                
                this.state.pan.x += (dx / this.state.width) * 2 * aspect;
                this.state.pan.y -= (dy / this.state.height) * 2;
                
                this.state.mouse.lastX = e.clientX; 
                this.state.mouse.lastY = e.clientY;
            }
            
            // 2. Coordinate Tracking for Tooltip
            const world = getScreenToWorld(e.clientX, e.clientY);
            
            // Update State
            this.state.hover.sx = e.pageX;
            this.state.hover.sy = e.pageY;
            this.state.hover.wx = world.x;
            this.state.hover.wy = world.y;
            this.state.hover.active = true;

            this._updateTooltip(e.pageX, e.pageY, world.x, world.y);
        });

        this.container.addEventListener('wheel', e => {
            e.preventDefault();
            const worldBefore = getScreenToWorld(e.clientX, e.clientY);
            const zoomFactor = 1 - e.deltaY * 0.001;
            this.state.zoom = Math.max(0.05, Math.min(this.state.zoom * zoomFactor, 50.0));
            this.state.pan.x = worldBefore.clipX - (worldBefore.x * this.state.zoom);
            this.state.pan.y = worldBefore.clipY - (worldBefore.y * this.state.zoom);
            
            const worldAfter = getScreenToWorld(e.clientX, e.clientY);
            // Update hover state
            this.state.hover.wx = worldAfter.x;
            this.state.hover.wy = worldAfter.y;
            this._updateTooltip(e.pageX, e.pageY, worldAfter.x, worldAfter.y);
        }, { passive: false });

        window.addEventListener('resize', () => this._resize());
        
        // --- TOUCH EVENTS ---
        let lastPinchDist = 0;
        this.container.addEventListener('touchstart', e => {
            if (e.touches.length === 1) {
                this.state.mouse.lastX = e.touches[0].clientX;
                this.state.mouse.lastY = e.touches[0].clientY;
            } else if (e.touches.length === 2) {
                const t1 = e.touches[0], t2 = e.touches[1];
                lastPinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
            }
        }, { passive: false });

        this.container.addEventListener('touchmove', e => {
            e.preventDefault(); 
            if (e.touches.length === 1) {
                const t = e.touches[0];
                const dx = t.clientX - this.state.mouse.lastX;
                const dy = t.clientY - this.state.mouse.lastY;
                const aspect = this.state.width / this.state.height;

                this.state.pan.x += (dx / this.state.width) * 2 * aspect;
                this.state.pan.y -= (dy / this.state.height) * 2;
                this.state.mouse.lastX = t.clientX;
                this.state.mouse.lastY = t.clientY;

                const world = getScreenToWorld(t.clientX, t.clientY);
                this.state.hover.sx = t.clientX;
                this.state.hover.sy = t.clientY;
                this.state.hover.wx = world.x;
                this.state.hover.wy = world.y;
                this.state.hover.active = true;
                
                this._updateTooltip(t.clientX, t.clientY, world.x, world.y);

            } else if (e.touches.length === 2) {
                const t1 = e.touches[0], t2 = e.touches[1];
                const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
                if (lastPinchDist > 0) {
                    const midX = (t1.clientX + t2.clientX) / 2;
                    const midY = (t1.clientY + t2.clientY) / 2;
                    const worldBefore = getScreenToWorld(midX, midY);
                    const zoomDelta = currentDist / lastPinchDist;
                    this.state.zoom = Math.max(0.05, Math.min(this.state.zoom * zoomDelta, 50.0));
                    this.state.pan.x = worldBefore.clipX - (worldBefore.x * this.state.zoom);
                    this.state.pan.y = worldBefore.clipY - (worldBefore.y * this.state.zoom);
                }
                lastPinchDist = currentDist;
            }
        }, { passive: false });
        
        this.container.addEventListener('touchend', () => { lastPinchDist = 0; });
        
        this.container.addEventListener('mouseleave', () => {
             this.state.hover.active = false;
             if (this.ui.tooltipMode === 'follow' && this.tooltip) this.tooltip.style.display = 'none';
        });
    }

    _updateTooltip(screenX, screenY, wx, wy) {
        if (!this.tooltip || !this.ui.tooltipEnabled) return;

        // Positioning
        if (this.ui.tooltipMode === 'follow') {
            this.tooltip.style.display = 'block';
            this.tooltip.style.left = `${screenX + 15}px`;
            this.tooltip.style.top = `${screenY + 15}px`;
        }

        // Content
        const lines = [];

        // 1. Lat/Lon Calculation
        if (this.ui.showLatLon) {
            const DEG2RAD = Math.PI/180;
            let finalLon = wx / DEG2RAD;
            let mercLat = 2.0 * Math.atan(Math.exp(wy)) - (Math.PI / 2.0);
            let latRad = (1 - this.state.morph) * wy + this.state.morph * mercLat;
            let finalLat = latRad / DEG2RAD;
            lines.push(`Lat: ${finalLat.toFixed(2)}°, Lon: ${finalLon.toFixed(2)}°`);
        }

        // 2. Value from external source (stream.js)
        if (this.ui.showValue) {
            if (this.ui.currentHoverValue) lines.push(this.ui.currentHoverValue);
            else lines.push("Value: No Data");
        }

        this.tooltip.innerHTML = lines.join('<br>');
    }

    _render(time) {
        if (Math.abs(this.state.morph - this.state.targetMorph) > 0.001) {
            this.state.morph += (this.state.targetMorph - this.state.morph) * 0.3;
        } else { this.state.morph = this.state.targetMorph; }

        this.gl.clearColor(...this.backgroundColor);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        this.gl.uniform1f(this.locs.morph, this.state.morph);
        this.gl.uniform2f(this.locs.scale, this.state.zoom, this.state.zoom);
        this.gl.uniform2f(this.locs.offset, this.state.pan.x, this.state.pan.y);
        this.gl.uniform2f(this.locs.resolution, this.state.width, this.state.height);

        // 1. Draw Raster Layers
        this.gl.uniform1f(this.locs.isRaster, 1.0);
        this.gl.enableVertexAttribArray(this.locs.uv);
        
        this.rasters.forEach(layer => {
            this.gl.uniform1f(this.locs.opacity, layer.opacity);
            
            // Set Uniforms for Data Scaling
            this.gl.uniform1f(this.locs.dataMin, layer.dataMin);
            this.gl.uniform1f(this.locs.dataMax, layer.dataMax);

            // Bind Texture 0: Data (Float)
            this.gl.activeTexture(this.gl.TEXTURE0);
            this.gl.bindTexture(this.gl.TEXTURE_2D, layer.dataTexture);
            this.gl.uniform1i(this.locs.dataTexture, 0);

            // Bind Texture 1: LUT (Color Gradient)
            this.gl.activeTexture(this.gl.TEXTURE1);
            this.gl.bindTexture(this.gl.TEXTURE_2D, layer.lutTexture);
            this.gl.uniform1i(this.locs.lutTexture, 1);

            // Bind Geometry
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, layer.posBuffer);
            this.gl.vertexAttribPointer(this.locs.pos, 2, this.gl.FLOAT, false, 0, 0);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, layer.uvBuffer);
            this.gl.vertexAttribPointer(this.locs.uv, 2, this.gl.FLOAT, false, 0, 0);
            this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, layer.indBuffer);
            
            this.gl.drawElements(this.gl.TRIANGLES, layer.count, this.gl.UNSIGNED_SHORT, 0);
        });

        // 2. Draw Vector Layers
        this.gl.uniform1f(this.locs.isRaster, 0.0);
        this.gl.disableVertexAttribArray(this.locs.uv);
        
        this.layers.forEach(layer => {
            if (layer.count > 0) {
                this.gl.uniform4fv(this.locs.color, layer.color); 
                this.gl.bindBuffer(this.gl.ARRAY_BUFFER, layer.buffer);
                this.gl.vertexAttribPointer(this.locs.pos, 2, this.gl.FLOAT, false, 0, 0);
                this.gl.drawArrays(this.gl.LINES, 0, layer.count);
            }
        });

        // 3. Draw Overlays
        this.callbacks.forEach(cb => cb(this));
        
        requestAnimationFrame((t) => this._render(t));
    }
}