/** Planar DXF boundary triangulation without a runtime dependency. */
const EPSILON = 64 * Number.EPSILON;

function invalid(message) {
  const error = new TypeError(`Invalid DXF boundary: ${message}`);
  error.code = 'DXF_INVALID_BOUNDARY';
  return error;
}

function worldPoint(value) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length < 2) throw invalid('points must contain x, y, and optional z coordinates.');
  const point = [value[0], value[1], value[2] ?? 0];
  if (!point.every(v => typeof v === 'number' && Number.isFinite(v))) throw invalid('point coordinates must be finite numbers.');
  return point;
}

function equal(a, b) { return a.every((v, i) => v === b[i]); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function determinant(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function orientation(a, b, c) {
  const left = (b.x - a.x) * (c.y - a.y), right = (b.y - a.y) * (c.x - a.x);
  const error = 16 * Number.EPSILON * (Math.abs(left) + Math.abs(right));
  return Math.abs(left - right) <= error ? 0 : Math.sign(left - right);
}
function onSegment(a, b, p) {
  return p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON &&
    p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}
function intersects(a, b, c, d) {
  const abC = orientation(a, b, c), abD = orientation(a, b, d);
  const cdA = orientation(c, d, a), cdB = orientation(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0) ||
    (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b));
}
function contains(ring, point) {
  if (point.x < ring.minX || point.x > ring.maxX || point.y < ring.minY || point.y > ring.maxY) return false;
  let inside = false;
  for (let i = 0, j = ring.points.length - 1; i < ring.points.length; j = i++) {
    const a = ring.points[i], b = ring.points[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (b.x - a.x) * ((point.y - a.y) / (b.y - a.y))) inside = !inside;
  }
  return inside;
}

/**
 * Triangulate simple coplanar world-space perimeter loops, in any input order or
 * winding. The result is an array of [x,y,z] points in consecutive triangle
 * triples. Numerically coincident closing and consecutive points are allowed.
 *
 * Normal (0) fills alternating nested regions; Outer (1) fills outer loops minus
 * their immediate holes; Ignore (2) fills the outer loops completely. Crossing,
 * touching, self-intersecting, degenerate, and nonplanar boundaries are rejected.
 *
 * The algorithm projects onto the plane's most stable coordinate pair, validates
 * boundary topology, and partitions the fill into horizontal trapezoids. It may
 * introduce vertices along edges. Interpolation in world space preserves tilted
 * planes and avoids losing precision by reconstructing large world coordinates
 * from a normalized projection. maxVertices bounds the output before allocation.
 */
export function triangulateDxfLoops(loops, { style = 'Normal', maxVertices = 4_000_000 } = {}) {
  const styles = { normal: 0, outer: 1, ignore: 2 };
  const mode = typeof style === 'string' ? styles[style.toLowerCase()] : style;
  if (![0, 1, 2].includes(mode)) throw invalid('hatch style must be Normal, Outer, or Ignore (0, 1, or 2).');
  if (!Number.isSafeInteger(maxVertices) || maxVertices < 0) throw new RangeError('maxVertices must be a nonnegative safe integer.');
  if (!Array.isArray(loops) || !loops.length) throw invalid('at least one perimeter loop is required.');

  const ringExtents = [];
  const worldLoops = loops.map(loop => {
    if (!Array.isArray(loop)) throw invalid('each loop must be an array of points.');
    const raw = loop.map(worldPoint), points = [];
    let extent = 0;
    for (const p of raw) for (let i = 0; i < 3; i++) extent = Math.max(extent, Math.abs(p[i] - raw[0][i]));
    if (!Number.isFinite(extent)) throw invalid('coordinate extents must be finite.');
    ringExtents.push(extent);
    // Arc samplers may repeat a closing point with a final sin(2π) rounding
    // residual. Use each ring's extent so distant components do not erase small
    // local features. Topology below rejects any remaining near-touch ambiguity.
    const coincident = (a, b) => equal(a, b) || a.every((v, i) => Math.abs(v - b[i]) <= EPSILON * extent);
    for (const p of raw) {
      if (!points.length || !coincident(p, points.at(-1))) points.push(p);
    }
    if (points.length > 1 && coincident(points[0], points.at(-1))) points.pop();
    if (points.length < 3) throw invalid('each loop needs at least three distinct perimeter points.');
    return points;
  });
  const origin = worldLoops[0][0];
  let scale = 0;
  for (const loop of worldLoops) for (const p of loop) for (let i = 0; i < 3; i++) scale = Math.max(scale, Math.abs(p[i] - origin[i]));
  if (!(scale > 0) || !Number.isFinite(scale)) throw invalid('coordinate extents must be finite and nonzero.');
  const localLoops = worldLoops.map(loop => loop.map(p => p.map((v, i) => (v - origin[i]) / scale)));

  // Choose a long baseline and its largest cross product to avoid relying on a
  // possibly collinear first triple or a canceling Newell normal in a bowtie.
  let baseline = localLoops[0][1], baselineLength = 0;
  for (const p of localLoops[0]) {
    const length = Math.hypot(...p);
    if (length > baselineLength) { baseline = p; baselineLength = length; }
  }
  let normal = [0, 0, 0], normalLength = 0;
  for (const p of localLoops[0]) {
    const candidate = cross(baseline, p), length = Math.hypot(...candidate);
    if (length > normalLength) { normal = candidate; normalLength = length; }
  }
  if (!(normalLength > 0)) throw invalid('a perimeter loop is collinear or has zero area.');
  normal = normal.map(v => v / normalLength);
  for (let ringIndex = 0; ringIndex < localLoops.length; ringIndex++) for (let pointIndex = 0; pointIndex < localLoops[ringIndex].length; pointIndex++) {
    const p = localLoops[ringIndex][pointIndex], world = worldLoops[ringIndex][pointIndex];
    const residual = Math.abs(p.reduce((sum, v, i) => sum + v * normal[i], 0));
    // Distant disjoint components must not grant each other a large allowance
    // perpendicular to the plane. Scale geometry tolerance by the individual
    // rings; separately account for dot-product and world-coordinate roundoff.
    const roundoff = p.reduce((sum, v, i) => {
      const weight = Math.abs(normal[i]);
      return sum + Math.abs(v * normal[i]) + (Math.abs(world[i]) * weight) / scale + (Math.abs(origin[i]) * weight) / scale;
    }, 0);
    const tolerance = 1e-10 * Math.max(ringExtents[0], ringExtents[ringIndex]) / scale + EPSILON * roundoff;
    if (residual > tolerance) throw invalid('all perimeter loops must be coplanar.');
  }
  const dropped = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2]) ? 0 : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
  const axes = [0, 1, 2].filter(i => i !== dropped);
  const rings = localLoops.map((loop, ringIndex) => {
    const points = loop.map((p, i) => ({ x: p[axes[0]], y: p[axes[1]], world: worldLoops[ringIndex][i] }));
    const ring = { points, depth: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    let area = 0, absoluteArea = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], next = points[(i + 1) % points.length];
      ring.minX = Math.min(ring.minX, p.x); ring.maxX = Math.max(ring.maxX, p.x);
      ring.minY = Math.min(ring.minY, p.y); ring.maxY = Math.max(ring.maxY, p.y);
      if (p.x === next.x && p.y === next.y) throw invalid('distinct perimeter points collapse in the boundary plane.');
      const part = determinant(points[0], p, next);
      area += part; absoluteArea += Math.abs(part);
      const previous = points[(i + points.length - 1) % points.length];
      if (orientation(previous, p, next) === 0 && (previous.x - p.x) * (next.x - p.x) + (previous.y - p.y) * (next.y - p.y) > 0) {
        throw invalid('adjacent perimeter edges overlap.');
      }
    }
    if (Math.abs(area) <= EPSILON * absoluteArea || area === 0) throw invalid('a perimeter loop has zero or numerically ambiguous area.');
    return ring;
  });

  const edges = [];
  for (const ring of rings) for (let i = 0; i < ring.points.length; i++) {
    const a = ring.points[i], b = ring.points[(i + 1) % ring.points.length];
    edges.push({ a, b, ring, index: i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
  }
  const ordered = edges.slice().sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    for (let j = i + 1; j < ordered.length && ordered[j].minX <= a.maxX + EPSILON; j++) {
      const b = ordered[j];
      if (b.minY > a.maxY + EPSILON || a.minY > b.maxY + EPSILON) continue;
      if (a.ring === b.ring) {
        const distance = Math.abs(a.index - b.index);
        if (distance === 1 || distance === a.ring.points.length - 1) continue;
      }
      if (intersects(a.a, a.b, b.a, b.b)) throw invalid('perimeter edges intersect or touch.');
    }
  }
  for (const ring of rings) for (const other of rings) if (ring !== other && contains(other, ring.points[0])) ring.depth++;

  const events = new Map();
  const event = y => {
    if (!events.has(y)) events.set(y, { starts: [], ends: [] });
    return events.get(y);
  };
  for (const edge of edges) {
    if ((mode === 1 && edge.ring.depth > 1) || (mode === 2 && edge.ring.depth > 0) || edge.minY === edge.maxY) continue;
    event(edge.minY).starts.push(edge); event(edge.maxY).ends.push(edge);
  }
  const levels = [...events.keys()].sort((a, b) => a - b), active = new Set(), result = [];
  const at = (edge, y) => {
    if (y === edge.a.y) return edge.a;
    if (y === edge.b.y) return edge.b;
    const t = (y - edge.a.y) / (edge.b.y - edge.a.y);
    return { x: edge.a.x + (edge.b.x - edge.a.x) * t, y, world: edge.a.world.map((v, i) => v + (edge.b.world[i] - v) * t) };
  };
  const triangle = (a, b, c) => {
    const area = determinant(a, b, c);
    if (area <= 0) {
      if (area < -EPSILON) throw invalid('boundary interpolation produced an inverted triangle.');
      return;
    }
    // A strip narrower than one world-coordinate ulp may collapse during
    // interpolation after a large translation. Do not emit a degenerate face.
    const ab = b.world.map((v, i) => (v - a.world[i]) / scale);
    const ac = c.world.map((v, i) => (v - a.world[i]) / scale);
    if (Math.hypot(...cross(ab, ac)) === 0) return;
    if (result.length + 3 > maxVertices) {
      const error = new RangeError(`DXF geometry exceeds maxVertices (${maxVertices}).`);
      error.code = 'DXF_VERTEX_LIMIT'; throw error;
    }
    result.push(a.world, b.world, c.world);
  };
  for (let i = 0; i + 1 < levels.length; i++) {
    const low = levels[i], high = levels[i + 1];
    for (const edge of events.get(low).ends) active.delete(edge);
    for (const edge of events.get(low).starts) active.add(edge);
    // Symmetric curves often have adjacent event levels one ulp apart: their
    // midpoint can round to an endpoint. Average the endpoint intersections and
    // break ties by those endpoints instead of sampling a boundary-aligned Y.
    const crossings = [...active].map(edge => {
      const lower = at(edge, low), upper = at(edge, high);
      return { lower, upper, x: lower.x + (upper.x - lower.x) / 2 };
    }).sort((a, b) => a.x - b.x || a.lower.x - b.lower.x || a.upper.x - b.upper.x);
    if (crossings.length % 2) throw invalid('the boundary has an unpaired scanline crossing.');
    for (let j = 0; j < crossings.length; j += 2) {
      const left = crossings[j], right = crossings[j + 1];
      const a = left.lower, b = right.lower, c = right.upper, d = left.upper;
      triangle(a, b, c); triangle(a, c, d);
    }
  }
  if (!result.length) throw invalid('the perimeter encloses no fillable area.');
  return result;
}
