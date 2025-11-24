class AdaptiveMap {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.overlays = []; // 2D DOM Overlays
        this.layers = [];   // Vector Layers
        this.rasters = [];  // WebGL Raster Layers (Heatmaps)
        this.callbacks = []; 
        
        this._idCounter = 0;

        this.state = {
            morph: 0.0, targetMorph: 0.0, zoom: 0.5,
            pan: { x: 0, y: 0 },
            width: this.container.clientWidth,
            height: this.container.clientHeight,
            mouse: { x: 0, y: 0, down: false, lastX: 0, lastY: 0 }
        };

        this.canvas = document.createElement('canvas');
        this.container.appendChild(this.canvas);
        this.gl = this.canvas.getContext('webgl', { antialias: true });

        if (!this.gl) throw new Error("WebGL not supported");

        this._initShaders();
        this._initEvents();
        this._resize();
        requestAnimationFrame((t) => this._render(t));
    }

    // --- 1. DOM Overlay System (HUD/Static) ---
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

    // --- 2. WebGL Raster System (Morphing Map Surface) ---
    /**
     * Adds a raster layer that sticks to the map and morphs.
     * @param {HTMLCanvasElement} sourceCanvas - The canvas containing the image/heatmap
     * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat] in degrees
     */
    addRaster(sourceCanvas, bbox) {
        const id = `raster_${this._idCounter++}`;
        const gl = this.gl;
        const PI = Math.PI;
        const DEG2RAD = PI / 180;

        // 1. Create Mesh Grid within BBox
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
                
                uv.push(u, 1.0 - v); // Flip V for WebGL texture coords
                
                // Interpolate Position based on BBox
                const lon = minLon + (u * lonRange);
                const lat = minLat + (v * latRange);
                pos.push(lon, lat);
            }
        }

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const a = y * (cols + 1) + x, b = a + 1, c = a + (cols + 1), d = c + 1;
                ind.push(a, b, c, b, d, c);
            }
        }

        // 2. Create Buffers
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);

        const uvBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);

        const indBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ind), gl.STATIC_DRAW);

        // 3. Create Texture
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Set parameters so any size canvas works
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // Upload initial data
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

        this.rasters.push({
            id, source: sourceCanvas, texture,
            posBuffer, uvBuffer, indBuffer, count: ind.length,
            opacity: 0.8
        });

        return id;
    }

    // Call this if you change the content of your canvas and want the map to update
    updateRaster(id) {
        const layer = this.rasters.find(r => r.id === id);
        if (layer) {
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, layer.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source);
        }
    }

    // --- 3. Vector Layer System ---
    async addLayer(url, objectName, color = [1.0, 1.0, 1.0, 1.0]) {
        const id = `layer_${this._idCounter++}`;
        try {
            document.getElementById('status').innerText = `Loading ${objectName}...`;
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
            document.getElementById('status').innerText = `Ready.`;
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
    toggleProjection() { this.state.targetMorph = this.state.targetMorph < 0.5 ? 1.0 : 0.0; }

    projectLatLonToScreen(lat, lon) {
        const PI = Math.PI; const RAD = PI / 180;
        let rLon = lon * RAD; let rLat = lat * RAD;
        let xCyl = rLon; let yCyl = rLat;
        let latClamped = Math.max(-1.48, Math.min(1.48, rLat));
        let yMerc = Math.log(Math.tan((PI / 4.0) + (latClamped / 2.0)));

        let wx = xCyl * (1 - this.state.morph) + rLon * this.state.morph;
        let wy = yCyl * (1 - this.state.morph) + yMerc * this.state.morph;

        let camX = (wx * this.state.zoom) + this.state.pan.x;
        let camY = (wy * this.state.zoom) + this.state.pan.y;
        let aspect = this.state.width / this.state.height;
        let clipX = camX / aspect; let clipY = camY; 

        let screenX = (clipX + 1) * 0.5 * this.state.width;
        let screenY = (-clipY + 1) * 0.5 * this.state.height;
        return { x: screenX, y: screenY };
    }

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
            texture: this.gl.getUniformLocation(this.program, 'u_texture'),
            pos: this.gl.getAttribLocation(this.program, 'a_position'),
            uv: this.gl.getAttribLocation(this.program, 'a_uv')
        };
        this.gl.enableVertexAttribArray(this.locs.pos);
    }

    _initEvents() {
        const getScreenToWorld = (sx, sy) => {
            const aspect = this.state.width / this.state.height;
            const normX = (sx / this.state.width) * 2 - 1;
            const normY = -((sy / this.state.height) * 2 - 1);
            return {
                x: (normX * aspect - this.state.pan.x) / this.state.zoom,
                y: (normY - this.state.pan.y) / this.state.zoom,
                clipX: normX * aspect, clipY: normY
            };
        };

        this.container.addEventListener('mousedown', e => {
            this.state.mouse.down = true;
            this.state.mouse.lastX = e.clientX; this.state.mouse.lastY = e.clientY;
        });
        window.addEventListener('mouseup', () => this.state.mouse.down = false);
        this.container.addEventListener('mousemove', e => {
            if (this.state.mouse.down) {
                const dx = e.clientX - this.state.mouse.lastX;
                const dy = e.clientY - this.state.mouse.lastY;
                const aspect = this.state.width / this.state.height;
                this.state.pan.x += (dx / this.state.width) * 2 * aspect;
                this.state.pan.y -= (dy / this.state.height) * 2;
                this.state.mouse.lastX = e.clientX; this.state.mouse.lastY = e.clientY;
            }
            const world = getScreenToWorld(e.clientX, e.clientY);
            this._updateCoordsUI(world.x, world.y);
        });
        this.container.addEventListener('wheel', e => {
            e.preventDefault();
            const worldBefore = getScreenToWorld(e.clientX, e.clientY);
            this.state.zoom = Math.max(0.05, Math.min(this.state.zoom * (1 - e.deltaY * 0.001), 50.0));
            this.state.pan.x = worldBefore.clipX - (worldBefore.x * this.state.zoom);
            this.state.pan.y = worldBefore.clipY - (worldBefore.y * this.state.zoom);
        }, { passive: false });
        window.addEventListener('resize', () => this._resize());
    }

    _updateCoordsUI(wx, wy) {
        const DEG2RAD = Math.PI/180;
        let finalLon = wx / DEG2RAD;
        let mercLat = 2.0 * Math.atan(Math.exp(wy)) - (Math.PI / 2.0);
        let latRad = (1 - this.state.morph) * wy + this.state.morph * mercLat;
        let finalLat = latRad / DEG2RAD;
        document.getElementById('coords').innerText = `Lat: ${finalLat.toFixed(2)}°, Lon: ${finalLon.toFixed(2)}°`;
    }

    _render(time) {
        if (Math.abs(this.state.morph - this.state.targetMorph) > 0.001) {
            this.state.morph += (this.state.targetMorph - this.state.morph) * 0.3;
        } else { this.state.morph = this.state.targetMorph; }

        this.gl.clearColor(0.05, 0.07, 0.09, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        this.gl.uniform1f(this.locs.morph, this.state.morph);
        this.gl.uniform2f(this.locs.scale, this.state.zoom, this.state.zoom);
        this.gl.uniform2f(this.locs.offset, this.state.pan.x, this.state.pan.y);
        this.gl.uniform2f(this.locs.resolution, this.state.width, this.state.height);

        // 1. Draw Raster Layers (Heatmaps)
        this.gl.uniform1f(this.locs.isRaster, 1.0);
        this.gl.enableVertexAttribArray(this.locs.uv);
        
        this.rasters.forEach(layer => {
            this.gl.uniform1f(this.locs.opacity, layer.opacity);
            
            // Bind Mesh
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, layer.posBuffer);
            this.gl.vertexAttribPointer(this.locs.pos, 2, this.gl.FLOAT, false, 0, 0);
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, layer.uvBuffer);
            this.gl.vertexAttribPointer(this.locs.uv, 2, this.gl.FLOAT, false, 0, 0);
            this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, layer.indBuffer);

            // Bind Texture
            this.gl.activeTexture(this.gl.TEXTURE0);
            this.gl.bindTexture(this.gl.TEXTURE_2D, layer.texture);
            this.gl.uniform1i(this.locs.texture, 0);

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