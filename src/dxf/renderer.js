import { tessellateDxfScene, validateDxfGeometry } from './geometry.js';

// One orthographic XY projection, shared by both topology pipelines. Z remains in
// scene buffers for consumers that provide their own 3D rendering implementation.
const SHADER = `
struct View { transform: vec4f }
@group(0) @binding(0) var<uniform> view: View;
struct VertexOutput { @builtin(position) position: vec4f, @location(0) color: vec4f }
@vertex fn vertexMain(@location(0) position: vec3f, @location(1) color: vec4f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f((position.xy - view.transform.zw) * view.transform.xy, 0.0, 1.0);
  output.color = color;
  return output;
}
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f { return input.color; }
`;
const USAGE = { COPY_DST: 0x0008, VERTEX: 0x0020, UNIFORM: 0x0040 };
function failure(message, code, cause) { const e = new Error(message, cause ? { cause } : undefined); e.code = code; return e; }
function finite(value, name) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite.`); return value; }

/** Create an on-demand WebGPU renderer. Requires a secure context with WebGPU. */
export async function createDxfRenderer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('A canvas is required.');
  const gpu = options.gpu ?? globalThis.navigator?.gpu;
  if (!gpu && !options.device) throw failure('WebGPU is unavailable. Open this page over HTTPS or localhost in a browser with WebGPU enabled.', 'WEBGPU_UNAVAILABLE');
  let device = options.device, adapter;
  if (!device) {
    adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' });
    if (!adapter) throw failure('No WebGPU adapter is available. DXF compilation and export can still run without a GPU.', 'WEBGPU_UNAVAILABLE');
    device = await adapter.requestDevice();
  }
  let renderer;
  try {
    const context = canvas.getContext('webgpu');
    if (!context) throw failure('The canvas could not create a WebGPU context.', 'WEBGPU_UNAVAILABLE');
    renderer = new DxfRenderer(canvas, device, context, options, !options.device);
    renderer.adapter = adapter;
    await renderer.initialize(options.format ?? gpu?.getPreferredCanvasFormat() ?? 'bgra8unorm');
    return renderer;
  } catch (error) {
    if (renderer) renderer.dispose(); else if (!options.device) device.destroy();
    throw error;
  }
}

class DxfRenderer {
  constructor(canvas, device, context, options, ownsDevice) {
    this.canvas = canvas; this.device = device; this.context = context;
    this.options = options; this.ownsDevice = ownsDevice;
    this.geometry = null; this.buffers = {}; this.visibility = new Map();
    this.camera = { x: 0, y: 0, scale: 1 };
    this.disposed = false; this.lost = null; this.frame = null; this.listeners = [];
    this.width = 1; this.height = 1; this.frames = 0; this.drawCalls = 0;
    this.background = options.background ?? [0.035, 0.047, 0.07, 1];
    if (!Array.isArray(this.background) || this.background.length !== 4 || !this.background.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new RangeError('background must have four normalized color components.');
    this.maxBufferBytes = options.maxBufferBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBufferBytes) || this.maxBufferBytes < 16) throw new RangeError('maxBufferBytes must be an integer of at least 16.');
    this.errorListener = event => this.report(failure(event.error?.message ?? 'Uncaptured WebGPU error.', 'WEBGPU_ERROR', event.error));
    device.addEventListener?.('uncapturederror', this.errorListener);
    device.lost?.then(info => {
      if (this.disposed) return;
      this.lost = failure(`WebGPU device lost (${info.reason ?? 'unknown'}): ${info.message ?? 'create a new renderer to recover'}`, 'WEBGPU_DEVICE_LOST');
      this.cancelFrame(); this.report(this.lost);
    });
  }
  async initialize(format) {
    this.context.configure({ device: this.device, format, alphaMode: 'opaque' });
    const device = this.device;
    device.pushErrorScope('validation');
    let pipelineError;
    try {
      const shader = device.createShaderModule({ label: 'RoslynWeb DXF shader', code: SHADER });
      const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform', minBindingSize: 16 } }] });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const descriptor = topology => ({
        label: `RoslynWeb DXF ${topology}`, layout: pipelineLayout,
        vertex: { module: shader, entryPoint: 'vertexMain', buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] },
        ] },
        fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }] },
        primitive: { topology, cullMode: 'none' },
      });
      [this.linePipeline, this.trianglePipeline] = await Promise.all([
        device.createRenderPipelineAsync(descriptor('line-list')),
        device.createRenderPipelineAsync(descriptor('triangle-list')),
      ]);
      this.uniform = device.createBuffer({ label: 'DXF view', size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });
      this.bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    } catch (error) { pipelineError = error; }
    const validationError = await device.popErrorScope();
    if (pipelineError || validationError) throw failure(`WebGPU pipeline initialization failed: ${(pipelineError ?? validationError).message}`, 'WEBGPU_PIPELINE_ERROR', pipelineError ?? validationError);
    this.assertActive();
    this.resize();
    if (this.options.autoResize !== false && globalThis.ResizeObserver && typeof this.canvas.getBoundingClientRect === 'function') {
      this.observer = new ResizeObserver(() => { if (!this.disposed && !this.lost) this.resize(); });
      this.observer.observe(this.canvas);
    }
    if (this.options.controls !== false) this.attachControls();
  }
  assertActive() {
    if (this.disposed) throw failure('DXF renderer is disposed.', 'DXF_RENDERER_DISPOSED');
    if (this.lost) throw this.lost;
  }
  report(error) { this.options.onError?.(error); }
  get stats() {
    const g = this.geometry;
    return { lineSegments: g?.lines.positions.length / 6 || 0, triangles: g?.triangles.positions.length / 9 || 0, vertices: (g?.lines.positions.length ?? 0) / 3 + (g?.triangles.positions.length ?? 0) / 3, drawCalls: this.drawCalls, frames: this.frames, width: this.canvas.width, height: this.canvas.height, disposed: this.disposed, lost: Boolean(this.lost) };
  }
  setScene(scene, options = {}) {
    this.assertActive();
    const geometry = tessellateDxfScene(scene, { ...this.options.tessellation, ...options });
    this.setGeometry(geometry, options);
    return geometry;
  }
  setGeometry(geometry, options = {}) {
    this.assertActive(); validateDxfGeometry(geometry);
    if (options.fit !== false && options.padding !== undefined && (!Number.isFinite(options.padding) || options.padding < 0 || options.padding >= 0.5)) throw new RangeError('padding must be between zero and 0.5.');
    const arrays = [geometry.lines.positions, geometry.lines.colors, geometry.triangles.positions, geometry.triangles.colors];
    const deviceLimit = this.device.limits?.maxBufferSize ?? 256 * 1024 * 1024;
    if (arrays.some(a => a.byteLength > deviceLimit) || arrays.reduce((sum, a) => sum + a.byteLength, 16) > this.maxBufferBytes) throw failure('DXF geometry exceeds the GPU buffer budget. Increase tessellation tolerance or maxBufferBytes.', 'DXF_GPU_BUFFER_LIMIT');
    const replacement = {};
    try {
      for (const name of ['lines', 'triangles']) {
        replacement[name] = {};
        for (const attribute of ['positions', 'colors']) {
          const array = geometry[name][attribute];
          if (!array.byteLength) continue;
          const buffer = this.device.createBuffer({ label: `DXF ${name} ${attribute}`, size: array.byteLength, usage: USAGE.VERTEX | USAGE.COPY_DST });
          replacement[name][attribute] = buffer;
          this.device.queue.writeBuffer(buffer, 0, array);
        }
      }
    } catch (error) { this.destroyBuffers(replacement); throw error; }
    this.destroyBuffers(this.buffers); this.buffers = replacement;
    this.geometry = geometry;
    this.visibility = new Map(geometry.layers.map(layer => [layer.name, layer.visible !== false]));
    for (const layer of geometry.layerStates ?? []) this.visibility.set(layer.name, layer.visible !== false);
    if (options.fit !== false) this.fit(options.padding ?? 0.08); else this.invalidate();
    return this;
  }
  destroyBuffers(buffers) { for (const batch of Object.values(buffers)) for (const buffer of Object.values(batch)) buffer.destroy(); }
  setLayerVisibility(name, visible) {
    this.assertActive();
    if (!this.visibility.has(name)) return false;
    this.visibility.set(name, Boolean(visible)); this.invalidate(); return true;
  }
  fit(padding = 0.08) {
    this.assertActive(); finite(padding, 'padding');
    if (padding < 0 || padding >= 0.5) throw new RangeError('padding must be between zero and 0.5.');
    const b = this.geometry?.bounds;
    if (!b) return this;
    this.camera.x = b.minX / 2 + b.maxX / 2; this.camera.y = b.minY / 2 + b.maxY / 2;
    const range = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-9);
    const w = Math.max(b.maxX - b.minX, range / 100), h = Math.max(b.maxY - b.minY, range / 100);
    this.camera.scale = Math.max(1e-30, Math.min(1e30, (1 - padding * 2) * Math.min(this.width / w, this.height / h)));
    this.invalidate(); return this;
  }
  /** Pan by CSS pixel deltas; positive X/right and positive Y/down move the drawing. */
  setCamera(camera) {
    this.assertActive();
    const next = { ...this.camera, ...camera };
    for (const key of ['x', 'y', 'scale']) finite(next[key], key);
    if (next.scale <= 0 || next.scale < 1e-30 || next.scale > 1e30) throw new RangeError('Camera scale must be between 1e-30 and 1e30.');
    Object.assign(this.camera, next); this.invalidate(); return this;
  }
  pan(dx, dy) {
    this.assertActive(); finite(dx, 'dx'); finite(dy, 'dy');
    this.camera.x -= dx / this.camera.scale; this.camera.y += dy / this.camera.scale;
    this.invalidate(); return this;
  }
  /** Zoom around a point in canvas-local CSS pixels. */
  zoomAt(factor, x = this.width / 2, y = this.height / 2) {
    this.assertActive(); finite(factor, 'factor'); finite(x, 'x'); finite(y, 'y');
    if (factor <= 0) throw new RangeError('Zoom factor must be positive.');
    const before = this.screenToWorld(x, y);
    this.camera.scale = Math.max(1e-30, Math.min(1e30, this.camera.scale * factor));
    const after = this.screenToWorld(x, y);
    this.camera.x += before.x - after.x; this.camera.y += before.y - after.y;
    this.invalidate(); return this;
  }
  screenToWorld(x, y) {
    this.assertActive(); finite(x, 'x'); finite(y, 'y');
    return { x: this.camera.x + (x - this.width / 2) / this.camera.scale, y: this.camera.y - (y - this.height / 2) / this.camera.scale };
  }
  worldToScreen(x, y) {
    this.assertActive(); finite(x, 'x'); finite(y, 'y');
    return { x: (x - this.camera.x) * this.camera.scale + this.width / 2, y: (this.camera.y - y) * this.camera.scale + this.height / 2 };
  }
  resize(width, height, pixelRatio = this.options.pixelRatio ?? globalThis.devicePixelRatio ?? 1) {
    this.assertActive();
    const box = this.canvas.getBoundingClientRect?.();
    width ??= box?.width || this.canvas.clientWidth || this.canvas.width || 1;
    height ??= box?.height || this.canvas.clientHeight || this.canvas.height || 1;
    finite(width, 'width'); finite(height, 'height'); finite(pixelRatio, 'pixelRatio');
    if (width <= 0 || height <= 0 || pixelRatio <= 0) throw new RangeError('Canvas dimensions and pixelRatio must be positive.');
    const limit = this.device.limits?.maxTextureDimension2D ?? 8192;
    const ratio = Math.min(pixelRatio, limit / width, limit / height);
    this.width = width; this.height = height;
    const w = Math.max(1, Math.floor(width * ratio)), h = Math.max(1, Math.floor(height * ratio));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.invalidate(); return this;
  }
  invalidate() {
    if (this.disposed || this.lost || !this.bindGroup || this.frame !== null) return;
    if (globalThis.requestAnimationFrame) {
      this.frame = requestAnimationFrame(() => { this.frame = null; try { this.render(); } catch (error) { this.report(error); } });
    } else this.render();
  }
  cancelFrame() { if (this.frame !== null) globalThis.cancelAnimationFrame?.(this.frame); this.frame = null; }
  /** Submit a frame immediately. Use device.queue.onSubmittedWorkDone() to await GPU completion. */
  render() {
    this.assertActive(); this.cancelFrame();
    const geometry = this.geometry, origin = geometry?.origin ?? [0, 0, 0];
    const values = new Float32Array([2 * this.camera.scale / this.width, 2 * this.camera.scale / this.height, this.camera.x - origin[0], this.camera.y - origin[1]]);
    if (!values.every(Number.isFinite)) throw failure('The viewport exceeds Float32 projection limits; use fit() to restore the drawing.', 'DXF_VIEW_LIMIT');
    this.device.queue.writeBuffer(this.uniform, 0, values);
    const encoder = this.device.createCommandEncoder({ label: 'DXF frame' });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: this.background, loadOp: 'clear', storeOp: 'store' }] });
    pass.setBindGroup(0, this.bindGroup); this.drawCalls = 0;
    if (geometry) for (const name of ['triangles', 'lines']) {
      const buffers = this.buffers[name];
      if (!buffers?.positions) continue;
      pass.setPipeline(name === 'lines' ? this.linePipeline : this.trianglePipeline);
      pass.setVertexBuffer(0, buffers.positions); pass.setVertexBuffer(1, buffers.colors);
      const prefix = name === 'lines' ? 'line' : 'triangle';
      for (const layer of geometry.layers) {
        const count = layer[`${prefix}Count`];
        if (count && (layer.visibilityLayers ?? [layer.name]).every(name => this.visibility.get(name) !== false)) { pass.draw(count, 1, layer[`${prefix}First`], 0); this.drawCalls++; }
      }
    }
    pass.end(); this.device.queue.submit([encoder.finish()]); this.frames++;
    return this.stats;
  }
  attachControls() {
    const canvas = this.canvas;
    if (!canvas.addEventListener || typeof canvas.getBoundingClientRect !== 'function') return;
    const listen = (type, handler, options) => { canvas.addEventListener(type, handler, options); this.listeners.push(() => canvas.removeEventListener(type, handler, options)); };
    if (canvas.style) { const previous = canvas.style.touchAction; canvas.style.touchAction = 'none'; this.listeners.push(() => { canvas.style.touchAction = previous; }); }
    let drag;
    listen('pointerdown', event => {
      if (this.lost || event.button !== 0 || drag) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture?.(event.pointerId); event.preventDefault();
    });
    listen('pointermove', event => {
      if (!drag || event.pointerId !== drag.id || this.lost) return;
      this.pan(event.clientX - drag.x, event.clientY - drag.y); drag.x = event.clientX; drag.y = event.clientY;
    });
    const end = event => { if (drag?.id === event.pointerId) { if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId); drag = null; } };
    listen('pointerup', end); listen('pointercancel', end); listen('lostpointercapture', end);
    listen('wheel', event => {
      if (this.lost) return;
      const box = canvas.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
      this.zoomAt(Math.exp(Math.max(-2, Math.min(2, -delta * 0.001))), event.clientX - box.left, event.clientY - box.top);
      event.preventDefault();
    }, { passive: false });
    listen('dblclick', event => { if (!this.lost) this.fit(); event.preventDefault(); });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.cancelFrame(); this.observer?.disconnect();
    for (const remove of this.listeners) remove(); this.listeners.length = 0;
    this.device.removeEventListener?.('uncapturederror', this.errorListener);
    this.destroyBuffers(this.buffers); this.buffers = {}; this.uniform?.destroy();
    this.context.unconfigure?.(); if (this.ownsDevice) this.device.destroy();
    this.geometry = null; this.visibility.clear();
  }
}
