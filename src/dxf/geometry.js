/** CPU tessellation for the portable DXF scene format. All angles are degrees. */
import { triangulateDxfLoops } from './polygon.js';
import { estimateDxfTextCorners } from './text.js';
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const MAX_FLOAT = 3.4028234663852886e38;

function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}
function point(value, label = 'Point') {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} is missing.`);
  return Array.isArray(value) || ArrayBuffer.isView(value)
    ? [number(value[0], `${label}.x`), number(value[1], `${label}.y`), number(value[2] ?? 0, `${label}.z`)]
    : [number(value.x, `${label}.x`), number(value.y, `${label}.y`), number(value.z ?? 0, `${label}.z`)];
}
function positive(value, label) {
  number(value, label);
  if (value <= 0) throw new RangeError(`${label} must be positive.`);
  return value;
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function unit(value) { const p = point(value), length = positive(Math.hypot(...p), 'Normal length'); return p.map(v => v / length); }
function plane(normal) {
  const n = unit(normal ?? [0, 0, 1]);
  const x = unit(cross(Math.abs(n[0]) < 1 / 64 && Math.abs(n[1]) < 1 / 64 ? [0, 1, 0] : [0, 0, 1], n));
  return [x, cross(n, x)];
}
function color(value) {
  const rgba = value ?? [0.88, 0.92, 1, 1];
  if (!Array.isArray(rgba) && !ArrayBuffer.isView(rgba)) throw new TypeError('Color must contain normalized RGB or RGBA components.');
  if (rgba.length !== 3 && rgba.length !== 4) throw new TypeError('Color must contain three or four components.');
  return [0, 1, 2, 3].map(i => {
    const v = number(rgba[i] ?? 1, 'Color component');
    if (v < 0 || v > 1) throw new RangeError('Color components must be between zero and one.');
    return v;
  });
}
function curveSteps(radius, sweep, options) {
  const angularStep = options.tolerance > 0
    ? 2 * Math.acos(Math.max(-1, Math.min(1, 1 - options.tolerance / radius)))
    : TAU / options.curveSegments;
  // A nonzero lower bound also prevents an underflowed tolerance causing infinity.
  return Math.min(options.maxCurveSegments, Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(angularStep, 1e-10))));
}
function sweepDegrees(start, end, full = false) {
  if (full) return TAU;
  const raw = number(end, 'End angle') - number(start, 'Start angle');
  if (Math.abs(raw) >= 360) return TAU;
  return ((raw % 360) + 360) % 360 * DEG;
}

/**
 * Convert a DXF scene to non-indexed WebGPU line/triangle buffers. Coordinates are
 * rebased before Float32 conversion; origin and bounds retain double precision.
 * Unsupported/invalid entities produce issues, unless strict:true is requested.
 * Resource budgets always throw, rather than returning a silently truncated drawing.
 */
export function tessellateDxfScene(scene, options = {}) {
  if (!scene || scene.version !== 1 || !Array.isArray(scene.entities)) throw new TypeError('Expected a version:1 DXF scene with an entities array.');
  const settings = {
    curveSegments: options.curveSegments ?? 96,
    maxCurveSegments: options.maxCurveSegments ?? 4096,
    maxVertices: options.maxVertices ?? 4_000_000,
    tolerance: options.tolerance ?? 0,
    pointSize: options.pointSize ?? 0.5,
  };
  for (const key of ['curveSegments', 'maxCurveSegments', 'maxVertices']) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < (key === 'maxVertices' ? 2 : 4)) throw new RangeError(`${key} must be a positive integer of at least ${key === 'maxVertices' ? 2 : 4}.`);
  }
  if (!Number.isFinite(settings.tolerance) || settings.tolerance < 0) throw new RangeError('tolerance must be finite and nonnegative.');
  positive(settings.pointSize, 'pointSize');
  const groups = new Map();
  const texts = [], draws = [];
  const issues = [...(Array.isArray(scene.issues) ? scene.issues : [])];
  let vertexCount = 0, renderedEntities = 0;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const layerInfo = new Map((scene.layers ?? []).map(l => [l.name, l]));
  for (let index = 0; index < scene.entities.length; index++) {
    const entity = scene.entities[index];
    if (entity?.visible === false) continue;
    try {
      if (!entity || typeof entity.type !== 'string') throw new TypeError('Entity type is missing.');
      const type = entity.type.toUpperCase();
      const layer = String(entity.layer ?? '0');
      if (entity.visibilityLayers !== undefined && (!Array.isArray(entity.visibilityLayers) || !entity.visibilityLayers.every(v => typeof v === 'string'))) throw new TypeError('visibilityLayers must contain layer names.');
      const visibilityLayers = [...new Set([layer, ...(entity.visibilityLayers ?? [])])];
      const rgba = color(entity.color ?? layerInfo.get(layer)?.color);
      const lines = [], triangles = [];
      let text;
      const push = (target, points) => {
        if (vertexCount + texts.length * 6 + lines.length / 3 + triangles.length / 3 + points.length > settings.maxVertices) {
          const error = new RangeError(`DXF geometry exceeds maxVertices (${settings.maxVertices}).`);
          error.code = 'DXF_VERTEX_LIMIT';
          throw error;
        }
        for (const p of points) { p.forEach(v => number(v, 'Generated coordinate')); target.push(...p); }
      };
      const segment = (a, b) => push(lines, [a, b]);
      const arc = (center, axisX, axisY, radius, start, sweep, startZ = 0, endZ = startZ) => {
        const count = curveSteps(radius, sweep, settings);
        if (settings.tolerance > 0 && radius * (1 - Math.cos(Math.abs(sweep) / count / 2)) > settings.tolerance * (1 + 1e-9)) {
          issues.push({ code: 'DXF_CURVE_SEGMENT_LIMIT', entityIndex: index, type: entity.type, message: `Curve tessellation reached maxCurveSegments (${settings.maxCurveSegments}); the requested chord tolerance could not be met.` });
        }
        const sample = t => {
          const angle = start + sweep * t, c = Math.cos(angle), s = Math.sin(angle);
          return [center[0] + axisX[0] * c + axisY[0] * s, center[1] + axisX[1] * c + axisY[1] * s, center[2] + axisX[2] * c + axisY[2] * s + startZ + (endZ - startZ) * t];
        };
        let previous = sample(0);
        for (let i = 1; i <= count; i++) { const next = sample(i / count); segment(previous, next); previous = next; }
      };
      const polyline = (vertices, closed) => {
        if (!Array.isArray(vertices) || vertices.length < 2) throw new TypeError('Polyline needs at least two vertices.');
        if (entity.normal && vertices.some(p => Math.abs(p.bulge ?? 0) > 1e-12)) {
          const n = unit(entity.normal);
          if (Math.abs(n[0]) > 1e-12 || Math.abs(n[1]) > 1e-12 || n[2] < 0) throw new TypeError('Bulged polyline DTOs require world XY coordinates with a positive Z normal. Flatten tilted/negative-normal curves into SEGMENTS.');
        }
        const points = vertices.map(p => point(p));
        const count = closed ? points.length : points.length - 1;
        for (let i = 0; i < count; i++) {
          const a = points[i], b = points[(i + 1) % points.length];
          const bulge = number(vertices[i].bulge ?? 0, 'Bulge');
          if (Math.abs(bulge) < 1e-12 || (a[0] === b[0] && a[1] === b[1])) { segment(a, b); continue; }
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const offset = (1 - bulge * bulge) / (4 * bulge);
          const center = [(a[0] + b[0]) / 2 - dy * offset, (a[1] + b[1]) / 2 + dx * offset, 0];
          const radius = Math.hypot(a[0] - center[0], a[1] - center[1]);
          const first = lines.length;
          arc(center, [radius, 0, 0], [0, radius, 0], radius, Math.atan2(a[1] - center[1], a[0] - center[0]), 4 * Math.atan(bulge), a[2], b[2]);
          // Exact endpoint coordinates avoid accumulated gaps between adjacent entities.
          lines.splice(first, 3, ...a);
          lines.splice(lines.length - 3, 3, ...b);
        }
      };
      if (type === 'LINE') segment(point(entity.start), point(entity.end));
      else if (['POLYLINE', 'LWPOLYLINE', 'POLYLINE2D', 'POLYLINE3D', 'PATH'].includes(type)) polyline(entity.vertices, entity.closed === true);
      else if (type === 'SEGMENTS' || type === 'LINES') {
        if (!Array.isArray(entity.vertices) || entity.vertices.length % 2 !== 0) throw new TypeError('Segments need vertex pairs.');
        for (let i = 0; i < entity.vertices.length; i += 2) segment(point(entity.vertices[i]), point(entity.vertices[i + 1]));
      } else if (type === 'CIRCLE' || type === 'ARC') {
        const center = point(entity.center), radius = positive(entity.radius, 'Radius');
        const start = number(entity.startAngle ?? 0, 'Start angle');
        const [x, y] = plane(entity.normal);
        arc(center, x.map(v => v * radius), y.map(v => v * radius), radius, start * DEG, sweepDegrees(start, entity.endAngle ?? 360, type === 'CIRCLE'));
      } else if (type === 'ELLIPSE') {
        const center = point(entity.center), major = point(entity.majorAxis), ratio = positive(entity.ratio, 'Ellipse ratio');
        const radius = positive(Math.hypot(...major), 'Ellipse major axis');
        // DTO axes may carry a full 3D basis supplied by the managed extractor.
        const minor = entity.minorAxis ? point(entity.minorAxis) : cross(unit(entity.normal ?? [0, 0, 1]), major).map(v => v * ratio);
        const start = number(entity.startAngle ?? 0, 'Start angle');
        arc(center, major, minor, Math.max(radius, Math.hypot(...minor)), start * DEG, sweepDegrees(start, entity.endAngle ?? 360, entity.closed === true));
      } else if (['SOLID', 'TRACE', '3DFACE', 'FACE3D', 'TRIANGLES'].includes(type)) {
        if (!Array.isArray(entity.vertices)) throw new TypeError('Faces need vertices.');
        const vertices = entity.vertices.map(p => point(p));
        if (type === 'TRIANGLES') {
          if (vertices.length % 3) throw new TypeError('Triangles need vertex triples.');
          push(triangles, vertices);
        } else {
          if (vertices.length !== 3 && vertices.length !== 4) throw new TypeError('Faces need three or four vertices in perimeter order.');
          push(triangles, [vertices[0], vertices[1], vertices[2]]);
          if (vertices.length === 4) push(triangles, [vertices[0], vertices[2], vertices[3]]);
          if (entity.outline === true) for (let i = 0; i < vertices.length; i++) segment(vertices[i], vertices[(i + 1) % vertices.length]);
        }
      } else if (type === 'HATCH' || type === 'WIPEOUT') {
        if (!Array.isArray(entity.loops)) throw new TypeError('Filled boundaries need a loops array.');
        push(triangles, triangulateDxfLoops(entity.loops.map(loop => loop.map(p => point(p))), { style: entity.hatchStyle ?? 'Normal', maxVertices: settings.maxVertices - vertexCount - texts.length * 6 }));
      } else if (['TEXT', 'MTEXT', 'ATTRIB'].includes(type)) {
        if (vertexCount + (texts.length + 1) * 6 > settings.maxVertices) { const error = new RangeError(`DXF geometry exceeds maxVertices (${settings.maxVertices}).`); error.code = 'DXF_VERTEX_LIMIT'; throw error; }
        text = { ...entity, type, color: rgba, layer, visibilityLayers, entityIndex: index };
        text.corners = estimateDxfTextCorners(text);
      } else if (type === 'POINT') {
        const [x, y, z] = point(entity.position), half = positive(entity.size ?? settings.pointSize, 'Point size') / 2;
        segment([x - half, y, z], [x + half, y, z]); segment([x, y - half, z], [x, y + half, z]);
      } else {
        const error = new Error(`Rendering entity type ${entity.type} is unsupported; the DXF document retains it.`);
        error.code = 'DXF_UNSUPPORTED_ENTITY'; throw error;
      }
      const groupKey = JSON.stringify(visibilityLayers);
      let group = groups.get(groupKey);
      if (!group) { group = { layer, visibilityLayers, visible: layerInfo.get(layer)?.visible !== false, lines: [], lineColors: [], triangles: [], triangleColors: [] }; groups.set(groupKey, group); }
      // Draws preserve source order across layers and topology, including masks.
      if (triangles.length) draws.push({ kind: type === 'WIPEOUT' ? 'mask' : 'triangles', first: group.triangles.length / 3, count: triangles.length / 3, group });
      if (lines.length) draws.push({ kind: 'lines', first: group.lines.length / 3, count: lines.length / 3, group });
      if (text) {
        draws.push({ kind: 'text', first: texts.length, count: 1, group }); texts.push(text);
        for (const p of text.corners) { const [x, y] = point(p); bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y); bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y); }
      }
      for (const [positions, target, colors] of [[lines, group.lines, group.lineColors], [triangles, group.triangles, group.triangleColors]]) {
        for (let i = 0; i < positions.length; i += 3) {
          const x = number(positions[i], 'Generated X'), y = number(positions[i + 1], 'Generated Y');
          number(positions[i + 2], 'Generated Z');
          bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y); bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y);
          target.push(x, y, positions[i + 2]); colors.push(...rgba);
        }
      }
      vertexCount += (lines.length + triangles.length) / 3;
      if (lines.length || triangles.length || text) renderedEntities++;
    } catch (error) {
      if (options.strict || error.code === 'DXF_VERTEX_LIMIT' || error.code === 'DXF_TEXT_LIMIT' || error.code === 'DXF_TEXT_LAYOUT_LIMIT') throw error;
      issues.push({ code: error.code ?? 'DXF_INVALID_ENTITY', entityIndex: index, type: entity?.type ?? null, message: error.message });
    }
  }
  if (!Number.isFinite(bounds.minX)) Object.assign(bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const origin = [bounds.minX / 2 + bounds.maxX / 2, bounds.minY / 2 + bounds.maxY / 2, 0];
  const lineCount = [...groups.values()].reduce((n, g) => n + g.lines.length / 3, 0);
  const triangleCount = vertexCount - lineCount;
  const lines = { positions: new Float32Array(lineCount * 3), colors: new Float32Array(lineCount * 4) };
  const triangles = { positions: new Float32Array(triangleCount * 3), colors: new Float32Array(triangleCount * 4) };
  const layers = [];
  let lineOffset = 0, triangleOffset = 0;
  for (const group of groups.values()) {
    const layer = { name: group.layer, visible: group.visible, visibilityLayers: group.visibilityLayers, lineFirst: lineOffset, lineCount: group.lines.length / 3, triangleFirst: triangleOffset, triangleCount: group.triangles.length / 3 };
    group.lineOffset = lineOffset; group.triangleOffset = triangleOffset;
    for (const [source, target, offset, colors] of [[group.lines, lines, lineOffset, group.lineColors], [group.triangles, triangles, triangleOffset, group.triangleColors]]) {
      for (let i = 0; i < source.length; i++) {
        const relative = source[i] - origin[i % 3];
        if (!Number.isFinite(relative) || Math.abs(relative) > MAX_FLOAT) throw new RangeError('Drawing extents exceed Float32 geometry limits.');
        target.positions[offset * 3 + i] = relative;
      }
      target.colors.set(colors, offset * 4);
    }
    layers.push(layer); lineOffset += layer.lineCount; triangleOffset += layer.triangleCount;
  }
  const layerStates = new Map((scene.layers ?? []).map(l => [l.name, { name: l.name, visible: l.visible !== false }]));
  for (const layer of layers) for (const name of layer.visibilityLayers) if (!layerStates.has(name)) layerStates.set(name, { name, visible: true });
  const commands = [];
  for (const draw of draws) {
    const { group, kind, count } = draw;
    const first = draw.first + (kind === 'text' ? 0 : kind === 'lines' ? group.lineOffset : group.triangleOffset);
    const previous = commands.at(-1);
    if (kind !== 'text' && previous?.kind === kind && previous.first + previous.count === first && previous.layer === group.layer && JSON.stringify(previous.visibilityLayers) === JSON.stringify(group.visibilityLayers)) previous.count += count;
    else commands.push({ kind, first, count, layer: group.layer, visibilityLayers: group.visibilityLayers });
  }
  return { version: 1, lines, triangles, texts, draws: commands, bounds, origin, layers, layerStates: [...layerStates.values()], issues, counts: { entities: scene.entities.length, renderedEntities, lineSegments: lineCount / 2, triangles: triangleCount / 3, vertices: vertexCount, textQuads: texts.length } };
}

/** Validate externally supplied GPU geometry before allocating device resources. */
export function validateDxfGeometry(geometry) {
  if (!geometry || geometry.version !== 1) throw new TypeError('Expected version:1 DXF geometry.');
  for (const [name, stride] of [['lines', 2], ['triangles', 3]]) {
    const batch = geometry[name];
    if (!(batch?.positions instanceof Float32Array) || !(batch?.colors instanceof Float32Array)) throw new TypeError(`${name} positions/colors must be Float32Array values.`);
    if (batch.positions.length % (3 * stride) || batch.colors.length !== batch.positions.length / 3 * 4) throw new RangeError(`${name} buffer lengths do not match their topology.`);
    if (!batch.positions.every(Number.isFinite) || !batch.colors.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new RangeError(`${name} buffers contain invalid coordinates/colors.`);
  }
  const b = geometry.bounds;
  if (!b || ![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) || b.minX > b.maxX || b.minY > b.maxY) throw new RangeError('Geometry bounds are invalid.');
  if (!Array.isArray(geometry.origin) || geometry.origin.length !== 3 || !geometry.origin.every(Number.isFinite)) throw new RangeError('Geometry origin must have three finite coordinates.');
  if (!Array.isArray(geometry.layers)) throw new TypeError('Geometry layers must be an array.');
  if (geometry.layerStates !== undefined && (!Array.isArray(geometry.layerStates) || !geometry.layerStates.every(l => l && typeof l.name === 'string'))) throw new TypeError('Geometry layer states require valid names.');
  for (const layer of geometry.layers) {
    if (typeof layer.name !== 'string' || (layer.visibilityLayers !== undefined && (!Array.isArray(layer.visibilityLayers) || !layer.visibilityLayers.every(v => typeof v === 'string')))) throw new TypeError('Draw layers require valid names.');
    for (const name of ['line', 'triangle']) {
    const first = layer[`${name}First`], count = layer[`${name}Count`], stride = name === 'line' ? 2 : 3;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0 || first % stride || count % stride || first + count > geometry[`${name}s`].positions.length / 3) throw new RangeError('Layer draw range is invalid.');
    }
  }
  if (geometry.texts !== undefined && !Array.isArray(geometry.texts)) throw new TypeError('Geometry texts must be an array.');
  if (geometry.texts?.length && !Array.isArray(geometry.draws)) throw new TypeError('Text geometry requires ordered draw commands.');
  if (geometry.texts?.length && !Array.isArray(geometry.issues)) throw new TypeError('Text geometry requires an issues array.');
  for (const text of geometry.texts ?? []) { estimateDxfTextCorners(text); color(text.color); }
  if (geometry.draws !== undefined) {
    if (!Array.isArray(geometry.draws)) throw new TypeError('Geometry draws must be an array.');
    for (const draw of geometry.draws) {
      if (!['lines', 'triangles', 'mask', 'text'].includes(draw.kind) || typeof draw.layer !== 'string' || !Array.isArray(draw.visibilityLayers) || !draw.visibilityLayers.every(v => typeof v === 'string')) throw new TypeError('Geometry draw command is invalid.');
      const stride = draw.kind === 'lines' ? 2 : draw.kind === 'text' ? 1 : 3;
      const limit = draw.kind === 'text' ? (geometry.texts?.length ?? 0) : geometry[draw.kind === 'lines' ? 'lines' : 'triangles'].positions.length / 3;
      if (!Number.isSafeInteger(draw.first) || !Number.isSafeInteger(draw.count) || draw.first < 0 || draw.count < 0 || draw.first % stride || draw.count % stride || draw.first + draw.count > limit) throw new RangeError('Geometry draw range is invalid.');
    }
  }
  return geometry;
}
