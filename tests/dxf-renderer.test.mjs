import test from 'node:test';
import assert from 'node:assert/strict';
import { tessellateDxfScene, validateDxfGeometry } from '../src/dxf/geometry.js';
import { createDxfRenderer } from '../src/dxf/renderer.js';

const scene = (entities, layers = []) => ({ version: 1, entities, layers });
const line = (extra = {}) => ({ type: 'LINE', start: [0, 0], end: [10, 5], ...extra });
function worldPoints(geometry, kind = 'lines') {
  const result = [], p = geometry[kind].positions;
  for (let i = 0; i < p.length; i += 3) result.push([p[i] + geometry.origin[0], p[i + 1] + geometry.origin[1], p[i + 2] + geometry.origin[2]]);
  return result;
}
function near(a, b, tolerance = 1e-5) { assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`); }

test('DXF geometry rebases large world coordinates before converting to Float32', () => {
  const g = tessellateDxfScene(scene([line({ start: [1e12, -1e12], end: [1e12 + 0.125, -1e12 + 0.25] })]));
  assert.deepEqual(worldPoints(g), [[1e12, -1e12, 0], [1e12 + 0.125, -1e12 + 0.25, 0]]);
  assert.deepEqual(g.lines.positions, new Float32Array([-0.0625, -0.125, 0, 0.0625, 0.125, 0]));
  assert.equal(validateDxfGeometry(g), g);
});
test('DXF geometry groups buffers into stable per-layer draw ranges', () => {
  const g = tessellateDxfScene(scene([line({ layer: 'A', color: [1, 0, 0, 0.5] }), line({ layer: 'B' }), line({ layer: 'A' }), { type: 'SOLID', layer: 'B', vertices: [[0, 0], [1, 0], [1, 1], [0, 1]] }], [{ name: 'A', visible: false }, { name: 'B', color: [0, 1, 0] }]));
  assert.deepEqual(g.layers, [
    { name: 'A', visible: false, visibilityLayers: ['A'], lineFirst: 0, lineCount: 4, triangleFirst: 0, triangleCount: 0 },
    { name: 'B', visible: true, visibilityLayers: ['B'], lineFirst: 4, lineCount: 2, triangleFirst: 0, triangleCount: 6 },
  ]);
  assert.deepEqual([...g.lines.colors.slice(0, 4)], [1, 0, 0, 0.5]);
  assert.deepEqual([...g.triangles.colors.slice(0, 4)], [0, 1, 0, 1]);
  assert.deepEqual(g.counts, { entities: 4, renderedEntities: 4, lineSegments: 3, triangles: 2, vertices: 12 });
});
test('DXF circle sampling closes exactly and respects requested full-circle segmentation', () => {
  const g = tessellateDxfScene(scene([{ type: 'CIRCLE', center: [2, 3, 5], radius: 4 }]), { curveSegments: 32 });
  assert.equal(g.counts.lineSegments, 32);
  const points = worldPoints(g); near(points[0][0], points.at(-1)[0]); near(points[0][1], points.at(-1)[1]);
  assert.deepEqual(g.bounds, { minX: -2, minY: -1, maxX: 6, maxY: 7 });
  for (const p of points) { near(Math.hypot(p[0] - 2, p[1] - 3), 4); assert.equal(p[2], 5); }
});
test('DXF arc wraps counterclockwise across zero degrees', () => {
  const g = tessellateDxfScene(scene([{ type: 'ARC', center: [0, 0], radius: 2, startAngle: 350, endAngle: 10 }]), { curveSegments: 360 });
  assert.equal(g.counts.lineSegments, 20);
  const points = worldPoints(g); assert.ok(points[0][1] < 0); assert.ok(points.at(-1)[1] > 0); assert.ok(g.bounds.minX > 1.9);
});
test('DXF circle/arc uses the DXF arbitrary-axis basis for tilted and negative normals', () => {
  const tilted = tessellateDxfScene(scene([{ type: 'CIRCLE', center: [10, 20, 30], radius: 2, normal: [0, 1, 0] }]), { curveSegments: 4 });
  const points = worldPoints(tilted); near(points[0][0], 8); near(points[0][1], 20); near(points[0][2], 30); near(points[1][2], 32);
  const negative = tessellateDxfScene(scene([{ type: 'ARC', center: [0, 0], radius: 1, normal: [0, 0, -1], startAngle: 0, endAngle: 90 }]), { curveSegments: 4 });
  near(worldPoints(negative)[0][0], -1); near(worldPoints(negative).at(-1)[1], 1);
});
test('DXF chord-error tessellation scales with radius and has a hard segment cap', () => {
  const shape = { type: 'CIRCLE', center: [0, 0], radius: 100 };
  const g = tessellateDxfScene(scene([shape]), { tolerance: 0.01 });
  assert.ok(g.counts.lineSegments > 96);
  const p = worldPoints(g);
  for (let i = 0; i < p.length; i += 2) {
    const mid = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
    assert.ok(100 - Math.hypot(...mid) <= 0.01001);
  }
  assert.equal(tessellateDxfScene(scene([shape]), { tolerance: 1e-50, maxCurveSegments: 128 }).counts.lineSegments, 128);
});
for (const bulge of [1, -1, Math.tan(Math.PI / 8), 2]) test(`DXF polyline bulge ${bulge} preserves endpoints, signed sweep and elevation`, () => {
  const g = tessellateDxfScene(scene([{ type: 'LWPOLYLINE', vertices: [{ x: 0, y: 0, z: 2, bulge }, { x: 10, y: 0, z: 4 }], closed: false }]), { curveSegments: 32 });
  const p = worldPoints(g); near(p[0][0], 0); near(p[0][1], 0); near(p[0][2], 2); near(p.at(-1)[0], 10); near(p.at(-1)[1], 0); near(p.at(-1)[2], 4);
  if (bulge > 0) assert.ok(g.bounds.minY < 0); else assert.ok(g.bounds.maxY > 0);
});
test('DXF closed polyline emits closing edge; coincident vertices remain finite', () => {
  const g = tessellateDxfScene(scene([{ type: 'POLYLINE', closed: true, vertices: [{ x: 0, y: 0, bulge: 1 }, [0, 0], [1, 1]] }]));
  assert.equal(g.counts.lineSegments, 3); assert.ok(g.lines.positions.every(Number.isFinite));
  assert.deepEqual(worldPoints(g).at(-1), [0, 0, 0]);
});
test('DXF tilted or negative-normal bulges require managed world-space tessellation', () => {
  for (const normal of [[0, 1, 0], [0, 0, -1]]) {
    const g = tessellateDxfScene(scene([{ type: 'LWPOLYLINE', normal, vertices: [{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }] }]));
    assert.equal(g.counts.vertices, 0); assert.match(g.issues[0].message, /Flatten/);
  }
});
test('DXF ellipse supports oriented major/minor axes and parametric partial arcs', () => {
  const g = tessellateDxfScene(scene([{ type: 'ELLIPSE', center: [5, 10], majorAxis: [0, 4, 0], ratio: 0.5, startAngle: 0, endAngle: 90 }]), { curveSegments: 4 });
  const p = worldPoints(g); near(p[0][0], 5); near(p[0][1], 14); near(p.at(-1)[0], 3); near(p.at(-1)[1], 10);
  const tilted = tessellateDxfScene(scene([{ type: 'ELLIPSE', center: [0, 0], majorAxis: [2, 0, 0], minorAxis: [0, 0, 1], ratio: 0.5 }]), { curveSegments: 4 });
  assert.ok(worldPoints(tilted).some(p => p[2] === 1));
});
test('DXF triangle and segment DTOs retain world Z and face winding', () => {
  const g = tessellateDxfScene(scene([{ type: 'TRIANGLES', vertices: [[0, 0, 1], [1, 0, 2], [0, 1, 3]] }, { type: 'SEGMENTS', vertices: [[0, 0], [2, 2], [2, 2], [3, 0]] }]));
  assert.deepEqual(worldPoints(g, 'triangles'), [[0, 0, 1], [1, 0, 2], [0, 1, 3]]);
  assert.equal(g.counts.lineSegments, 2); assert.equal(g.counts.triangles, 1);
});
test('DXF points produce a world-space cross and hidden entities produce no geometry', () => {
  const g = tessellateDxfScene(scene([{ type: 'POINT', position: [5, 5], size: 2 }, line({ visible: false })]));
  assert.deepEqual(worldPoints(g), [[4, 5, 0], [6, 5, 0], [5, 4, 0], [5, 6, 0]]);
  assert.equal(g.counts.renderedEntities, 1);
});
test('DXF unsupported entities are reported without corrupting valid geometry', () => {
  const g = tessellateDxfScene(scene([{ type: 'TEXT', text: 'retained in document' }, line(), { type: 'LINE', start: [NaN, 0], end: [1, 1] }]));
  assert.equal(g.counts.vertices, 2); assert.equal(g.issues.length, 2);
  assert.equal(g.issues[0].code, 'DXF_UNSUPPORTED_ENTITY'); assert.equal(g.issues[1].entityIndex, 2);
  assert.deepEqual(g.bounds, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
  assert.throws(() => tessellateDxfScene(scene([{ type: 'TEXT' }]), { strict: true }), /unsupported/);
});
test('DXF geometry preserves extraction issues and reports generated nonfinite coordinates atomically', () => {
  const s = scene([line(), { type: 'CIRCLE', center: [Number.MAX_VALUE, 0], radius: Number.MAX_VALUE }]);
  s.issues = [{ code: 'EXTRACTION', message: 'Original warning.' }];
  const g = tessellateDxfScene(s);
  assert.equal(g.counts.vertices, 2); assert.equal(g.issues[0].code, 'EXTRACTION'); assert.equal(g.issues.length, 2);
  assert.deepEqual(g.bounds, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
});
test('DXF vertex limits reject the full operation instead of quietly truncating entities', () => {
  assert.throws(() => tessellateDxfScene(scene([line(), line()]), { maxVertices: 2 }), e => e.code === 'DXF_VERTEX_LIMIT');
  assert.throws(() => tessellateDxfScene(scene([{ type: 'CIRCLE', radius: 1, center: [0, 0] }]), { maxVertices: 4 }), e => e.code === 'DXF_VERTEX_LIMIT');
});
test('DXF validation rejects malformed scene, options, buffers and draw ranges', () => {
  assert.throws(() => tessellateDxfScene({ version: 2, entities: [] }), /version/);
  for (const options of [{ tolerance: -1 }, { pointSize: 0 }, { curveSegments: 3 }, { maxVertices: Infinity }]) assert.throws(() => tessellateDxfScene(scene([]), options));
  const g = tessellateDxfScene(scene([line()]));
  assert.throws(() => validateDxfGeometry({ ...g, lines: { ...g.lines, colors: new Float32Array(1) } }), /lengths/);
  assert.throws(() => validateDxfGeometry({ ...g, origin: [NaN, 0, 0] }), /origin/);
  assert.throws(() => validateDxfGeometry({ ...g, layers: [{ ...g.layers[0], lineFirst: 1 }] }), /range/);
  assert.throws(() => tessellateDxfScene(scene([line({ color: [255, 0, 0] })]), { strict: true }), /between zero and one/);
});
test('DXF empty geometry has stable finite bounds and no draw ranges', () => {
  const g = tessellateDxfScene(scene([]));
  assert.deepEqual(g.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 }); assert.equal(g.lines.positions.length, 0); assert.deepEqual(g.layers, []); validateDxfGeometry(g);
});

// These contract fixtures verify resource/lifecycle behavior only. A separate
// browser integration test compiles the WGSL and checks actual rendered pixels.
function gpuFixture(options = {}) {
  const calls = [], buffers = [], listeners = new Map(); let resolveLost;
  const device = {
    limits: { maxBufferSize: options.bufferLimit ?? 1024 * 1024, maxTextureDimension2D: options.textureLimit ?? 2048 },
    lost: new Promise(resolve => { resolveLost = resolve; }),
    queue: { writeBuffer(buffer, offset, data) { calls.push(['writeBuffer', buffer, [...data]]); }, submit(commands) { calls.push(['submit', commands]); }, async onSubmittedWorkDone() {} },
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
    pushErrorScope() { calls.push(['pushErrorScope']); }, async popErrorScope() { calls.push(['popErrorScope']); return options.validationError; },
    createShaderModule(descriptor) { calls.push(['shader', descriptor]); return {}; }, createBindGroupLayout() { return {}; }, createPipelineLayout() { return {}; },
    async createRenderPipelineAsync(descriptor) { calls.push(['pipeline', descriptor]); if (options.pipelineError) throw new Error('Pipeline refused.'); return { topology: descriptor.primitive.topology }; },
    createBuffer(descriptor) { if (options.failBufferAt === buffers.length) throw new Error('Allocation refused.'); const buffer = { ...descriptor, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(buffer); return buffer; },
    createBindGroup() { return {}; },
    createCommandEncoder() { return { beginRenderPass(descriptor) { calls.push(['pass', descriptor]); return { setBindGroup() {}, setPipeline(p) { calls.push(['setPipeline', p.topology]); }, setVertexBuffer() {}, draw(...args) { calls.push(['draw', ...args]); }, end() {} }; }, finish() { return {}; } }; },
    destroy() { calls.push(['destroyDevice']); },
  };
  const context = { configure(d) { calls.push(['configure', d]); }, getCurrentTexture() { return { createView() { return {}; } }; }, unconfigure() { calls.push(['unconfigure']); } };
  const events = new Map();
  const canvas = {
    width: 800, height: 600, style: { touchAction: 'auto' },
    getContext(name) { assert.equal(name, 'webgpu'); return context; }, getBoundingClientRect() { return { width: 800, height: 600, left: 10, top: 20 }; },
    addEventListener(type, handler) { events.set(type, handler); }, removeEventListener(type) { events.delete(type); }, setPointerCapture() {}, hasPointerCapture() { return false; },
  };
  const gpu = { async requestAdapter() { return { async requestDevice() { return device; } }; }, getPreferredCanvasFormat() { return 'bgra8unorm'; } };
  return { canvas, context, device, gpu, calls, buffers, events, listeners, resolveLost: info => resolveLost(info) };
}
test('WebGPU initialization builds actual line-list and triangle-list descriptors and a shared view uniform', async () => {
  const f = gpuFixture(), renderer = await createDxfRenderer(f.canvas, { gpu: f.gpu, controls: false });
  assert.deepEqual(f.calls.filter(c => c[0] === 'pipeline').map(c => c[1].primitive.topology), ['line-list', 'triangle-list']);
  assert.equal(f.buffers[0].size, 16); assert.match(f.calls.find(c => c[0] === 'shader')[1].code, /@vertex/);
  assert.equal(f.calls.find(c => c[0] === 'configure')[1].alphaMode, 'opaque');
  renderer.dispose(); assert.ok(f.buffers.every(b => b.destroyed)); assert.ok(f.calls.some(c => c[0] === 'destroyDevice'));
});
test('WebGPU renderer submits grouped draws and layer toggles do not upload geometry again', async () => {
  const f = gpuFixture(), renderer = await createDxfRenderer(f.canvas, { device: f.device, controls: false });
  renderer.setScene(scene([line({ layer: 'A' }), line({ layer: 'B' }), { type: 'SOLID', layer: 'B', vertices: [[0, 0], [1, 0], [0, 1]] }]));
  assert.equal(renderer.render().drawCalls, 3);
  const writes = f.calls.filter(c => c[0] === 'writeBuffer' && c[1].label !== 'DXF view').length;
  assert.equal(renderer.setLayerVisibility('B', false), true); assert.equal(renderer.render().drawCalls, 1);
  assert.equal(f.calls.filter(c => c[0] === 'writeBuffer' && c[1].label !== 'DXF view').length, writes);
  assert.equal(renderer.setLayerVisibility('missing', true), false);
  renderer.dispose(); assert.ok(!f.calls.some(c => c[0] === 'destroyDevice'), 'caller-provided devices remain caller-owned');
});
test('WebGPU hidden ancestor INSERT layers retain geometry and toggle all descendant draw ranges', async () => {
  const f = gpuFixture(), renderer = await createDxfRenderer(f.canvas, { device: f.device, controls: false });
  const g = renderer.setScene(scene([
    line({ layer: 'child', visibilityLayers: ['parent', 'child'] }),
    line({ layer: 'child' }),
  ], [{ name: 'parent', visible: false }, { name: 'child', visible: true }]));
  assert.equal(g.counts.lineSegments, 2); assert.equal(g.layers.length, 2); assert.equal(renderer.render().drawCalls, 1);
  const uploads = f.calls.filter(c => c[0] === 'writeBuffer' && c[1].label !== 'DXF view').length;
  assert.equal(renderer.setLayerVisibility('parent', true), true); assert.equal(renderer.render().drawCalls, 2);
  renderer.setLayerVisibility('child', false); assert.equal(renderer.render().drawCalls, 0);
  assert.equal(f.calls.filter(c => c[0] === 'writeBuffer' && c[1].label !== 'DXF view').length, uploads); renderer.dispose();
});
test('WebGPU camera fit, screen conversion, CSS-pixel pan and cursor-centered zoom agree', async () => {
  const f = gpuFixture(), renderer = await createDxfRenderer(f.canvas, { device: f.device, controls: false });
  renderer.setScene(scene([line({ start: [0, 0], end: [10, 10] })]));
  assert.deepEqual(renderer.worldToScreen(5, 5), { x: 400, y: 300 });
  const before = renderer.screenToWorld(200, 100); renderer.zoomAt(2, 200, 100);
  const after = renderer.screenToWorld(200, 100); near(before.x, after.x); near(before.y, after.y);
  const screenBefore = renderer.worldToScreen(0, 0); renderer.pan(20, -10); const screenAfter = renderer.worldToScreen(0, 0);
  near(screenAfter.x - screenBefore.x, 20); near(screenAfter.y - screenBefore.y, -10);
  renderer.setCamera({ x: 5, y: 5, scale: 20 }); assert.equal(renderer.camera.scale, 20);
  assert.throws(() => renderer.zoomAt(0), /positive/); assert.throws(() => renderer.setCamera({ scale: -1 }), /scale/); assert.throws(() => renderer.fit(0.5), /padding/);
  renderer.dispose();
});
test('WebGPU resize preserves aspect ratio within device texture limits', async () => {
  const f = gpuFixture({ textureLimit: 1000 }), renderer = await createDxfRenderer(f.canvas, { device: f.device, controls: false });
  renderer.resize(2000, 1000, 2); assert.equal(f.canvas.width, 1000); assert.equal(f.canvas.height, 500);
  assert.throws(() => renderer.resize(0, 100), /positive/); renderer.dispose();
});
test('WebGPU OffscreenCanvas-style hosts render without DOM observers or controls', async () => {
  const f = gpuFixture(); delete f.canvas.getBoundingClientRect; delete f.canvas.style;
  const renderer = await createDxfRenderer(f.canvas, { device: f.device });
  renderer.setScene(scene([line()])); assert.equal(renderer.render().drawCalls, 1);
  assert.equal(f.events.size, 0); renderer.resize(640, 480, 1); assert.equal(renderer.stats.width, 640); renderer.dispose();
});
test('WebGPU device/budget limits preserve the previously uploaded scene', async () => {
  const f = gpuFixture(), renderer = await createDxfRenderer(f.canvas, { device: f.device, controls: false, maxBufferBytes: 150 });
  const original = renderer.setScene(scene([line()]));
  const previous = f.buffers.slice(1);
  assert.throws(() => renderer.setScene(scene([line(), line(), line()])), e => e.code === 'DXF_GPU_BUFFER_LIMIT');
  assert.equal(renderer.geometry, original); assert.ok(previous.every(b => !b.destroyed)); renderer.dispose();
});
test('WebGPU failed replacement validation and allocation leave old geometry intact and release temporary buffers', async () => {
  const options = {}, f = gpuFixture(options), renderer = await createDxfRenderer(f.canvas, { device: f.device, controls: false });
  const original = renderer.setScene(scene([line()])), previous = f.buffers.slice(1);
  assert.throws(() => renderer.setGeometry({ ...original, lines: { ...original.lines, positions: new Float32Array(1) } }), /lengths/);
  assert.throws(() => renderer.setGeometry(original, { padding: 1 }), /padding/);
  options.failBufferAt = f.buffers.length + 1;
  assert.throws(() => renderer.setScene(scene([line({ end: [20, 20] })])), /Allocation refused/);
  assert.equal(renderer.geometry, original); assert.ok(previous.every(b => !b.destroyed)); assert.ok(f.buffers.at(-1).destroyed);
  renderer.dispose();
});
test('WebGPU scene replacement destroys old buffers and disposal removes controls', async () => {
  const f = gpuFixture(), renderer = await createDxfRenderer(f.canvas, { device: f.device });
  renderer.setScene(scene([line()])); const previous = f.buffers.slice(1);
  renderer.setScene(scene([line({ end: [20, 20] })])); assert.ok(previous.every(b => b.destroyed));
  assert.equal(f.canvas.style.touchAction, 'none'); assert.ok(f.events.size > 0);
  renderer.dispose(); renderer.dispose(); assert.equal(f.events.size, 0); assert.equal(f.canvas.style.touchAction, 'auto'); assert.ok(f.buffers.every(b => b.destroyed));
  assert.throws(() => renderer.render(), e => e.code === 'DXF_RENDERER_DISPOSED');
});
test('WebGPU pointer/wheel controls use canvas-local CSS coordinates', async () => {
  const f = gpuFixture(), renderer = await createDxfRenderer(f.canvas, { device: f.device });
  renderer.setScene(scene([line()])); const x = renderer.camera.x;
  f.events.get('pointerdown')({ button: 0, pointerId: 1, clientX: 20, clientY: 30, preventDefault() {} });
  f.events.get('pointermove')({ pointerId: 1, clientX: 30, clientY: 30 }); assert.ok(renderer.camera.x < x);
  f.events.get('pointerup')({ pointerId: 1 });
  const before = renderer.screenToWorld(100, 100);
  f.events.get('wheel')({ deltaY: -200, deltaMode: 0, clientX: 110, clientY: 120, preventDefault() {} });
  const after = renderer.screenToWorld(100, 100); near(before.x, after.x); near(before.y, after.y); renderer.dispose();
});
test('WebGPU device loss is surfaced and prevents further submissions', async () => {
  const f = gpuFixture(), errors = [], renderer = await createDxfRenderer(f.canvas, { device: f.device, onError: e => errors.push(e) });
  f.resolveLost({ reason: 'unknown', message: 'Test adapter reset.' }); await Promise.resolve();
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'WEBGPU_DEVICE_LOST'); assert.equal(renderer.stats.lost, true);
  assert.throws(() => renderer.render(), e => e.code === 'WEBGPU_DEVICE_LOST'); renderer.dispose();
});
test('WebGPU uncaptured device errors reach the application callback', async () => {
  const f = gpuFixture(), errors = [], renderer = await createDxfRenderer(f.canvas, { device: f.device, onError: e => errors.push(e) });
  f.listeners.get('uncapturederror')({ error: new Error('GPU validation failed.') });
  assert.equal(errors[0].code, 'WEBGPU_ERROR'); assert.match(errors[0].message, /validation/); renderer.dispose(); assert.equal(f.listeners.size, 0);
});
test('WebGPU initialization failure pops its error scope and releases resources', async () => {
  for (const options of [{ pipelineError: true }, { validationError: { message: 'Bad shader.' } }]) {
    const f = gpuFixture(options);
    await assert.rejects(createDxfRenderer(f.canvas, { gpu: f.gpu }), e => e.code === 'WEBGPU_PIPELINE_ERROR');
    assert.ok(f.calls.some(c => c[0] === 'popErrorScope')); assert.ok(f.calls.some(c => c[0] === 'unconfigure')); assert.ok(f.calls.some(c => c[0] === 'destroyDevice')); assert.ok(f.buffers.every(b => b.destroyed));
  }
});
test('WebGPU missing adapter/context reports actionable unavailability', async () => {
  const f = gpuFixture();
  await assert.rejects(createDxfRenderer(f.canvas, { gpu: { async requestAdapter() { return null; } } }), e => e.code === 'WEBGPU_UNAVAILABLE');
  f.canvas.getContext = () => null;
  await assert.rejects(createDxfRenderer(f.canvas, { gpu: f.gpu }), e => e.code === 'WEBGPU_UNAVAILABLE');
  assert.ok(f.calls.some(c => c[0] === 'destroyDevice'));
});
