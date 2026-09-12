import { triangulateDxfLoops } from './polygon.js';

const EPS = 64 * Number.EPSILON;
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function invalid(message) { return Object.assign(new TypeError(`Invalid DXF hatch pattern: ${message}`), { code: 'DXF_INVALID_HATCH_PATTERN' }); }
function point(value) {
  const p = Array.isArray(value) || ArrayBuffer.isView(value) ? [value[0], value[1], value[2] ?? 0] : [value?.x, value?.y, value?.z ?? 0];
  if (!p.every(v => typeof v === 'number' && Number.isFinite(v))) throw invalid('origins and basis vectors must be finite.');
  return p;
}
const tolerance = (...values) => EPS * Math.max(1, ...values.map(Math.abs));

/**
 * Clip infinite affine line families to the validated filled region. Positive
 * dash lengths draw, negative lengths leave gaps, and zero lengths draw square
 * dot markers. Dashes repeat in both directions, anchored at each family origin.
 * Reusing the fill's triangles gives Normal/Outer/Ignore identical topology and
 * keeps holes correct independently of loop ordering, winding, and block shear.
 * Work and output budgets are checked before expanding dense lines or dashes.
 */
export function tessellateDxfPattern(loops, pattern, { style = 'Normal', maxVertices = 4_000_000,
  maxHatchLines = 100_000, maxHatchWork = 10_000_000, hatchDotSize, budget } = {}) {
  if (!pattern || !Array.isArray(pattern.lines) || !pattern.lines.length) throw invalid('at least one line definition is required.');
  if (hatchDotSize !== undefined && (!(hatchDotSize > 0) || !Number.isFinite(hatchDotSize))) throw invalid('hatchDotSize must be positive and finite.');
  const state = budget ?? { lines: 0, work: 0 };
  const work = (amount = 1) => {
    state.work += amount;
    if (state.work > maxHatchWork) throw Object.assign(new RangeError(`DXF hatch work exceeds maxHatchWork (${maxHatchWork}).`), { code: 'DXF_HATCH_WORK_LIMIT' });
  };
  // Boundary triangulation is temporary clipping data, also subject to a budget.
  const fill = triangulateDxfLoops(loops, { style, maxVertices: Math.min(maxHatchWork * 3, 4_000_000), work });
  const anchor = fill[0], normal = cross3(subtract(fill[1], anchor), subtract(fill[2], anchor));
  let extent = 0;
  for (const p of fill) for (let j = 0; j < 3; j++) extent = Math.max(extent, Math.abs(p[j] - anchor[j]));
  const normalLength = Math.hypot(...normal), n = normal.map(v => v / normalLength);
  const dropped = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  const axes = [0, 1, 2].filter(i => i !== dropped);
  const project = p => axes.map(i => p[i] - anchor[i]);
  const vectors = p => axes.map(i => p[i]);
  const lines = [], triangles = [];
  const append = (target, points) => {
    if (lines.length + triangles.length + points.length > maxVertices) throw Object.assign(new RangeError(`DXF geometry exceeds maxVertices (${maxVertices}).`), { code: 'DXF_VERTEX_LIMIT' });
    for (const p of points) {
      if (!p.every(Number.isFinite)) throw invalid('generated coordinates overflowed.');
      target.push(p);
    }
  };
  for (const definition of pattern.lines) {
    work();
    const origin = point(definition.origin), direction = point(definition.direction), offset = point(definition.offset);
    const d = vectors(direction), delta = vectors(offset), d2 = dot2(d, d), determinant = cross2(d, delta);
    if (!(d2 > 0) || !Number.isFinite(d2) || !Number.isFinite(determinant) || determinant === 0) throw invalid('line direction must be nonzero and perpendicular family spacing must be nonzero.');
    const inPlane = (v, label, isPosition = false) => {
      const relative = isPosition ? subtract(v, anchor) : v;
      const residual = Math.abs(relative.reduce((sum, x, i) => sum + x * n[i], 0));
      const rounding = EPS * relative.reduce((sum, x, i) => sum + Math.abs(x * n[i]) + (isPosition ? (Math.abs(v[i]) + Math.abs(anchor[i])) * Math.abs(n[i]) : 0), 0);
      if (residual > rounding + 1e-10 * (isPosition ? extent : Math.hypot(...relative))) throw invalid(`${label} must lie in the boundary plane.`);
    };
    inPlane(direction, 'direction'); inPlane(offset, 'offset'); inPlane(origin, 'origin', true);
    const coordinate = p => { const local = project(p); return [dot2(local, d) / d2, cross2(d, local) / d2]; };
    const o = coordinate(origin), ds = dot2(delta, d) / d2, dt = determinant / d2;
    const source = [];
    let minT = Infinity, maxT = -Infinity;
    for (let i = 0; i < fill.length; i += 3) {
      work();
      const vertices = fill.slice(i, i + 3).map(world => ({ q: coordinate(world), world }));
      for (const p of vertices) { minT = Math.min(minT, p.q[1]); maxT = Math.max(maxT, p.q[1]); }
      source.push({ vertices, minT: Math.min(...vertices.map(p => p.q[1])), maxT: Math.max(...vertices.map(p => p.q[1])) });
    }
    const firstValue = (minT - o[1]) / dt, lastValue = (maxT - o[1]) / dt;
    const first = Math.ceil(Math.min(firstValue, lastValue)), last = Math.floor(Math.max(firstValue, lastValue));
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) throw invalid('line indices exceed exact integer precision; move the pattern origin nearer the boundary.');
    const count = Math.max(0, last - first + 1);
    if (!Number.isSafeInteger(count) || state.lines + count > maxHatchLines) throw Object.assign(new RangeError(`DXF hatch exceeds maxHatchLines (${maxHatchLines}).`), { code: 'DXF_HATCH_LINE_LIMIT' });
    state.lines += count;
    const dashes = definition.dashes ?? [];
    if (!Array.isArray(dashes)) throw invalid('dash lengths must be an array.');
    work(dashes.length);
    if (!dashes.every(value => typeof value === 'number' && Number.isFinite(value))) throw invalid('dash lengths must be finite numbers.');
    const period = dashes.reduce((sum, value) => sum + Math.abs(value), 0);
    if (dashes.length && (!(period > 0) || !Number.isFinite(period))) throw invalid('a dash cycle must have finite nonzero total length.');
    const dotSize = hatchDotSize ?? Math.min(Math.abs(dt), period || Math.abs(dt)) / 10;
    const perpendicular = definition.perpendicular ? point(definition.perpendicular) : cross3(n, direction);
    inPlane(perpendicular, 'dot perpendicular');
    if (dashes.includes(0) && cross2(d, vectors(perpendicular)) === 0) throw invalid('dot perpendicular must be independent of direction.');
    const at = (k, u) => origin.map((value, j) => value + k * offset[j] + u * direction[j]);
    const emitDot = (k, u) => {
      const center = at(k, u), half = dotSize / 2;
      const corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => {
        const world = center.map((v, j) => v + half * (x * direction[j] + y * perpendicular[j])); return { world, q: coordinate(world) };
      });
      const low = Math.min(...corners.map(p => p.q[1])), high = Math.max(...corners.map(p => p.q[1]));
      for (const triangle of source) {
        work(); if (triangle.minT > high || triangle.maxT < low) continue;
        let polygon = corners;
        const v = triangle.vertices;
        const winding = Math.sign(cross2(subtract(v[1].q,v[0].q), subtract(v[2].q,v[0].q)));
        for (let edge = 0; edge < 3 && polygon.length; edge++) {
          const a = v[edge].q, b = v[(edge + 1) % 3].q, vector = subtract(b, a), clipped = [];
          const side = p => winding * cross2(vector, subtract(p.q, a));
          let previous = polygon.at(-1), previousSide = side(previous);
          for (const p of polygon) {
            const currentSide = side(p);
            if ((currentSide >= 0) !== (previousSide >= 0)) {
              const t = previousSide / (previousSide - currentSide);
              clipped.push({ q: previous.q.map((x,j) => x + (p.q[j]-x)*t), world: previous.world.map((x,j) => x + (p.world[j]-x)*t) });
            }
            if (currentSide >= 0) clipped.push(p);
            previous = p; previousSide = currentSide;
          }
          polygon = clipped;
        }
        for (let j = 1; j + 1 < polygon.length; j++) {
          const a = polygon[0], b = polygon[j], c = polygon[j+1];
          if (cross2(subtract(b.q,a.q),subtract(c.q,a.q)) !== 0) append(triangles, [a.world,b.world,c.world]);
        }
      }
    };
    for (let k = first; k <= last; k++) {
      work(source.length);
      const t = o[1] + k * dt, s = o[0] + k * ds, intervals = [];
      for (const triangle of source) {
        if (t < triangle.minT || t > triangle.maxT) continue;
        const hits = [];
        for (let edge = 0; edge < 3; edge++) {
          const a = triangle.vertices[edge].q, b = triangle.vertices[(edge+1)%3].q;
          if (a[1] === t) hits.push(a[0] - s);
          if ((a[1] < t && b[1] > t) || (a[1] > t && b[1] < t)) hits.push(a[0] + (b[0]-a[0])*((t-a[1])/(b[1]-a[1])) - s);
        }
        if (hits.length > 1) {
          const low = Math.min(...hits), high = Math.max(...hits);
          if (high > low) intervals.push([low,high]);
        }
      }
      intervals.sort((a,b) => a[0]-b[0]);
      const merged = [];
      for (const [low,high] of intervals) {
        const previous = merged.at(-1);
        if (previous && low <= previous[1] + tolerance(low,previous[1])) previous[1] = Math.max(previous[1],high);
        else merged.push([low,high]);
      }
      for (const [low,high] of merged) {
        if (!dashes.length) { append(lines,[at(k,low),at(k,high)]); continue; }
        const firstCycle = Math.floor(low/period), lastCycle = Math.floor(high/period);
        if (!Number.isSafeInteger(firstCycle) || !Number.isSafeInteger(lastCycle)) throw invalid('dash phase exceeds exact integer precision; move the pattern origin nearer the boundary.');
        work((lastCycle-firstCycle+1)*dashes.length);
        for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
          let position = cycle*period;
          for (const dash of dashes) {
            if (dash === 0) { if (position >= low && position <= high) emitDot(k,position); }
            else if (dash > 0) { const a = Math.max(low,position), b = Math.min(high,position+dash); if (b>a) append(lines,[at(k,a),at(k,b)]); }
            position += Math.abs(dash);
          }
        }
      }
    }
  }
  return { lines, triangles };
}
