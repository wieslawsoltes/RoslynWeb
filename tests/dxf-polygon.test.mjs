import test from 'node:test';
import assert from 'node:assert/strict';
import { triangulateDxfLoops } from '../src/dxf/polygon.js';

const square = (x0, y0, x1, y1, z = 0) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

function triangleArea(a, b, c) {
  const u = b.map((value, axis) => value - a[axis]);
  const v = c.map((value, axis) => value - a[axis]);
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}

function checkedArea(vertices) {
  assert.ok(Array.isArray(vertices), 'triangulation returns an array');
  assert.equal(vertices.length % 3, 0, 'vertices form complete triangles');
  let area = 0;
  for (const vertex of vertices) {
    assert.ok(Array.isArray(vertex));
    assert.equal(vertex.length, 3, 'each vertex retains all three world coordinates');
    assert.ok(vertex.every(Number.isFinite), 'triangle coordinates are finite');
  }
  for (let i = 0; i < vertices.length; i += 3) {
    const triangle = triangleArea(vertices[i], vertices[i + 1], vertices[i + 2]);
    assert.ok(triangle > 0, 'triangulation does not emit degenerate triangles');
    area += triangle;
  }
  return area;
}

// Inclusive triangle edges make the probe independent of whichever diagonals
// the triangulator chooses. All probes stay away from the polygon boundaries.
function covers(vertices, point, project = vertex => vertex) {
  const side = (a, b, p) => {
    const left = (b[0] - a[0]) * (p[1] - a[1]), right = (b[1] - a[1]) * (p[0] - a[0]);
    const tolerance = 32 * Number.EPSILON * (Math.abs(left) + Math.abs(right));
    return Math.abs(left - right) <= tolerance ? 0 : Math.sign(left - right);
  };
  for (let i = 0; i < vertices.length; i += 3) {
    const [a, b, c] = vertices.slice(i, i + 3).map(project);
    const signs = [side(a, b, point), side(b, c, point), side(c, a, point)];
    if (signs.every(value => value >= 0) || signs.every(value => value <= 0)) return true;
  }
  return false;
}

function assertProbes(vertices, filled, empty, project) {
  for (const point of filled) assert.equal(covers(vertices, point, project), true, `expected fill at ${point}`);
  for (const point of empty) assert.equal(covers(vertices, point, project), false, `unexpected fill at ${point}`);
}

test('DXF polygon triangulates a concave outline without covering its cutout', () => {
  const outline = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
  for (const ring of [outline, outline.toReversed()]) {
    const vertices = triangulateDxfLoops([ring]);
    near(checkedArea(vertices), 20);
    assertProbes(vertices, [[1, 1], [5, 1], [1, 5]], [[3, 3], [5, 5], [-1, 1]]);
    assert.ok(vertices.every(vertex => vertex[2] === 0), 'omitted input Z becomes zero');
  }
});

test('DXF polygon removes consecutive duplicates and repeated closing points', () => {
  const vertices = triangulateDxfLoops([[[0, 0], [0, 0], [4, 0], [4, 0], [4, 4], [0, 4], [0, 0], [0, 0]]]);
  near(checkedArea(vertices), 16);
  assertProbes(vertices, [[1, 1], [3, 3]], [[5, 1]]);
});

test('DXF polygon accepts collinear vertices along an otherwise valid boundary', () => {
  const vertices = triangulateDxfLoops([[[0, 0], [2, 0], [4, 0], [4, 2], [4, 4], [0, 4], [0, 2]]]);
  near(checkedArea(vertices), 16);
  assertProbes(vertices, [[1, 1], [3, 3]], [[5, 1]]);
});

test('DXF polygon preserves two holes in a concave outer boundary', () => {
  const outer = [[0, 0], [12, 0], [12, 4], [8, 4], [8, 10], [0, 10]];
  const vertices = triangulateDxfLoops([outer, square(1, 1, 3, 3), square(4, 5, 7, 8).toReversed()]);
  near(checkedArea(vertices), 83);
  assertProbes(vertices, [[0.5, 5], [10, 2], [7.5, 7]], [[2, 2], [5, 6], [10, 6], [-1, 1]]);
});

const nested = [square(0, 0, 12, 12), square(2, 2, 10, 10), square(4, 4, 8, 8), square(5, 5, 7, 7)];
const nestedStyles = [
  { name: 'Normal', aliases: ['Normal', 'normal', 'nOrMaL', 0], area: 92, filled: [[1, 1], [4.5, 4.5]], empty: [[3, 3], [6, 6]] },
  { name: 'Outer', aliases: ['Outer', 'outer', 'oUtEr', 1], area: 80, filled: [[1, 1]], empty: [[3, 3], [4.5, 4.5], [6, 6]] },
  { name: 'Ignore', aliases: ['Ignore', 'ignore', 'iGnOrE', 2], area: 144, filled: [[1, 1], [3, 3], [4.5, 4.5], [6, 6]], empty: [] },
];

for (const style of nestedStyles) test(`DXF ${style.name} polygon style obeys nesting independently of order and winding`, () => {
  const rings = [nested[2].toReversed(), nested[0], nested[3], nested[1].toReversed()];
  for (const alias of style.aliases) {
    const vertices = triangulateDxfLoops(rings, { style: alias });
    near(checkedArea(vertices), style.area);
    assertProbes(vertices, style.filled, [...style.empty, [-1, 1], [13, 6]]);
  }
});

test('DXF polygon defaults to Normal even-odd island filling', () => {
  const vertices = triangulateDxfLoops(nested);
  near(checkedArea(vertices), 92);
  assertProbes(vertices, [[1, 1], [4.5, 4.5]], [[3, 3], [6, 6]]);
});

for (const style of ['Normal', 'Outer', 'Ignore']) test(`DXF ${style} polygon style handles disjoint roots and their holes`, () => {
  const rings = [square(21, 1, 23, 3), square(0, 0, 6, 6), square(20, 0, 24, 4).toReversed(), square(1, 1, 5, 5).toReversed()];
  const vertices = triangulateDxfLoops(rings, { style });
  const ignore = style === 'Ignore';
  near(checkedArea(vertices), ignore ? 52 : 32);
  assertProbes(vertices, [[0.5, 3], [20.5, 2], ...(ignore ? [[3, 3], [22, 2]] : [])], [[10, 2], ...(ignore ? [] : [[3, 3], [22, 2]])]);
});

test('DXF polygon retains a tilted plane and a hole in full world coordinates', () => {
  const lift = ([x, y]) => [x, y, 7 + 2 * x - 3 * y];
  const vertices = triangulateDxfLoops([square(0, 0, 10, 10).map(lift), square(3, 3, 7, 7).map(lift).toReversed()]);
  near(checkedArea(vertices), 84 * Math.sqrt(14), 1e-7);
  for (const [x, y, z] of vertices) near(z, 7 + 2 * x - 3 * y);
  assertProbes(vertices, [[1, 1], [9, 9]], [[5, 5], [11, 5]]);
});

test('DXF polygon triangulates a vertical plane with an interior hole', () => {
  const lift = ([u, v]) => [17, u, v];
  const vertices = triangulateDxfLoops([square(0, 0, 8, 6).map(lift), square(2, 2, 6, 4).map(lift)]);
  near(checkedArea(vertices), 40);
  assert.ok(vertices.every(vertex => vertex[0] === 17));
  assertProbes(vertices, [[1, 1], [7, 5]], [[4, 3], [9, 3]], vertex => [vertex[1], vertex[2]]);
});

test('DXF polygon is stable under large world-coordinate translations', () => {
  const origin = [1e12, -1e12, 2e12];
  const translate = point => point.map((value, axis) => value + origin[axis]);
  const local = vertex => vertex.map((value, axis) => value - origin[axis]);
  const vertices = triangulateDxfLoops([square(0, 0, 16, 12).map(translate), square(4, 3, 12, 9).map(translate)]);
  near(checkedArea(vertices), 144);
  assert.ok(vertices.every(vertex => vertex[2] === origin[2]));
  assertProbes(vertices, [[1, 1], [15, 11]], [[8, 6], [-1, 1]], local);
});

test('DXF polygon accepts symmetric sampled boundaries with nearly identical scanline levels', () => {
  for (const [count, phase] of [[6, 0], [12, Math.PI / 4]]) {
    const ring = Array.from({ length: count }, (_, i) => [Math.cos(i * 2 * Math.PI / count + phase), Math.sin(i * 2 * Math.PI / count + phase)]);
    const vertices = triangulateDxfLoops([ring]);
    near(checkedArea(vertices), count * Math.sin(2 * Math.PI / count) / 2);
    assertProbes(vertices, [[0, 0], [0.25, 0.25]], [[1.1, 0], [0, -1.1]]);
  }
});

test('DXF polygon closes sampled circular boundaries despite trigonometric rounding', () => {
  const segments = 96;
  const ring = Array.from({ length: segments + 1 }, (_, i) => [Math.cos(i * 2 * Math.PI / segments), Math.sin(i * 2 * Math.PI / segments)]);
  assert.notDeepEqual(ring[0], ring.at(-1), 'fixture retains the final sine rounding error');
  const vertices = triangulateDxfLoops([ring]);
  near(checkedArea(vertices), segments * Math.sin(2 * Math.PI / segments) / 2);
  assertProbes(vertices, [[0, 0], [0.5, 0.5]], [[1.1, 0], [0, -1.1]]);
});

test('DXF polygon preserves randomized radial perimeters and holes across coordinate scales', () => {
  let seed = 0x5a17c9e3;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const radial = (count, minimumRadius, radiusRange) => Array.from({ length: count }, (_, i) => {
    const angle = (i + 0.1 + random() * 0.8) * 2 * Math.PI / count;
    const radius = minimumRadius + random() * radiusRange;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
  });
  const ringArea = ring => Math.abs(ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  // Ray casting is independent of the triangle-area and triangle-probe helpers.
  const insideRing = (ring, point) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < a[0] + (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1])) inside = !inside;
    }
    return inside;
  };
  for (let fixture = 0; fixture < 8; fixture++) {
    const outer = radial(17 + fixture * 3, 7, 4);
    const hole = radial(7 + fixture, 1, 1);
    const expectedArea = ringArea(outer) - ringArea(hole);
    for (const scale of [1e-9, 1, 1e9]) {
      const transform = ring => ring.map(point => point.map(value => value * scale));
      const triangles = triangulateDxfLoops([transform(hole).toReversed(), transform(outer)]);
      const local = triangles.map(point => point.map(value => value / scale));
      near(checkedArea(local), expectedArea, expectedArea * 1e-12);
      for (let probe = 0; probe < 80; probe++) {
        const point = [random() * 24 - 12, random() * 24 - 12];
        const expected = insideRing(outer, point) && !insideRing(hole, point);
        assert.equal(covers(local, point), expected, `fixture ${fixture}, scale ${scale}, point ${point}`);
      }
      // Each emitted triangle must also remain in the valid region; this catches
      // tiny stray triangles that a sparse coverage grid can miss.
      for (let i = 0; i < local.length; i += 3) {
        const center = [0, 1].map(axis => (local[i][axis] + local[i + 1][axis] + local[i + 2][axis]) / 3);
        assert.equal(insideRing(outer, center), true, 'triangle centroid lies inside the outer boundary');
        assert.equal(insideRing(hole, center), false, 'triangle centroid stays outside the hole');
      }
    }
  }
});

const malformedBoundaries = [
  ['a missing loop list', null],
  ['an object loop list', {}],
  ['a missing ring', [null]],
  ['an empty ring', [[]]],
  ['a two-point ring', [[[0, 0], [1, 1]]]],
  ['an underspecified point', [[[0, 0], [1], [0, 1]]]],
  ['a missing point', [[[0, 0], null, [0, 1]]]],
  ['a nonnumeric coordinate', [[[0, 0], ['1', 0], [0, 1]]]],
  ['a NaN coordinate', [[[0, 0], [NaN, 0], [0, 1]]]],
  ['an infinite coordinate', [[[0, 0], [1, Infinity], [0, 1]]]],
  ['a nonfinite Z coordinate', [[[0, 0, 0], [1, 0, NaN], [0, 1, 0]]]],
  ['a ring of identical points', [[[1, 1], [1, 1], [1, 1], [1, 1]]]],
  ['a collinear ring', [[[0, 0], [1, 1], [2, 2], [3, 3]]]],
];
for (const [name, loops] of malformedBoundaries) test(`DXF polygon rejects ${name} with a boundary error`, () => {
  assert.throws(() => triangulateDxfLoops(loops), error => error.code === 'DXF_INVALID_BOUNDARY');
});

const invalidTopology = [
  ['a bow-tie self intersection', [[[0, 0], [4, 4], [0, 4], [4, 0]]]],
  ['a nonzero-area self intersection', [[[0, 0], [4, 4], [0, 4], [4, 0], [5, 2]]]],
  ['a nonadjacent repeated vertex', [[[0, 0], [4, 0], [2, 2], [4, 4], [0, 4], [2, 2]]]],
  ['crossing rings', [square(0, 0, 4, 4), square(2, 2, 6, 6)]],
  ['rings touching at one vertex', [square(0, 0, 4, 4), square(4, 4, 6, 6)]],
  ['rings sharing an edge', [square(0, 0, 4, 4), square(4, 0, 6, 4)]],
  ['a hole touching the outer edge', [square(0, 0, 6, 6), [[0, 3], [2, 2], [2, 4]]]],
  ['coincident rings', [square(0, 0, 4, 4), square(0, 0, 4, 4).toReversed()]],
];
for (const [name, loops] of invalidTopology) test(`DXF polygon rejects ${name} for every fill style`, () => {
  for (const style of ['Normal', 'Outer', 'Ignore']) {
    assert.throws(() => triangulateDxfLoops(loops, { style }), error => error.code === 'DXF_INVALID_BOUNDARY');
  }
});

test('DXF polygon rejects a nonplanar ring and rings on different planes', () => {
  const boundaries = [
    [[[0, 0, 0], [6, 0, 0], [6, 6, 1], [0, 6, 0]]],
    [square(0, 0, 6, 6, 0), square(2, 2, 4, 4, 1)],
    [square(0, 0, 6, 6, 0), square(10, 0, 12, 2, 1)],
    // Large in-plane separation must not relax the perpendicular tolerance.
    [square(0, 0, 10, 10, 0), square(1e12, 0, 1e12 + 10, 10, 1)],
  ];
  for (const loops of boundaries) assert.throws(() => triangulateDxfLoops(loops), error => error.code === 'DXF_INVALID_BOUNDARY');
});

test('DXF polygon enforces the output vertex budget without truncating triangles', () => {
  const triangle = [[[0, 0], [4, 0], [0, 4]]];
  near(checkedArea(triangulateDxfLoops(triangle, { maxVertices: 3 })), 8);
  assert.throws(() => triangulateDxfLoops(triangle, { maxVertices: 2 }), error => error.code === 'DXF_VERTEX_LIMIT');
  const rings = [square(0, 0, 10, 10), square(3, 3, 7, 7)];
  const expected = triangulateDxfLoops(rings);
  assert.throws(() => triangulateDxfLoops(rings, { maxVertices: expected.length - 1 }), error => error.code === 'DXF_VERTEX_LIMIT');
  const vertices = triangulateDxfLoops(rings, { maxVertices: expected.length });
  assert.equal(vertices.length, expected.length);
  near(checkedArea(vertices), 84);
  assertProbes(vertices, [[1, 1]], [[5, 5]]);
});
