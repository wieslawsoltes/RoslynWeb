import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDxfText, prepareDxfText, createDxfTextLayout, estimateDxfTextCorners } from '../src/dxf/text.js';

const label = (overrides = {}) => ({ type: 'TEXT', text: 'AB', position: [0, 0, 0], height: 1, ...overrides });
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} should equal ${b}`);

// Canvas contract fixture: metrics are deterministic, while tests below verify
// complete Unicode strings reach fillText. Actual browser shaping and GPU pixels
// belong to the separate browser integration test.
function canvasFixture({ overhang = 0, missingFont = false } = {}) {
  const calls = [], canvas = { width: 1, height: 1 };
  const context = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '', direction: '',
    measureText(text) {
      calls.push(['measure', text, this.font]);
      let width = [...text].reduce((n, char) => n + (/\p{Mark}/u.test(char) ? 0 : char === ' ' || char === '\u00a0' ? 16 : 32), 0);
      if (missingFont && this.font.includes('monospace')) width *= 1.1;
      if (missingFont && this.font.includes('serif') && !this.font.includes('sans-serif')) width *= 1.2;
      if (text === 'ffi') width = 70; // A shaped run need not equal individual advances.
      return { width, actualBoundingBoxAscent: text ? 48 : 0, actualBoundingBoxDescent: /[gjpqy]/.test(text) ? 12 : 0, actualBoundingBoxLeft: text ? overhang : 0, actualBoundingBoxRight: width + (text ? overhang : 0) };
    },
    fillText(...args) { calls.push(['draw', ...args, this.fillStyle, this.font]); },
    clearRect(...args) { calls.push(['clear', ...args]); },
    setTransform(...args) { calls.push(['transform', ...args]); },
  };
  canvas.getContext = name => { assert.equal(name, '2d'); return context; };
  return { canvas, context, calls, canvasFactory: () => canvas };
}

test('DXF text decodes CAD symbols, Unicode escapes and surrogate pairs without losing ordinary Unicode', () => {
  const result = normalizeDxfText(label({ text: String.raw`%%d %%P %%c \U+03A9 \U+D83D\U+DE80 中文 العربية é` }));
  assert.equal(result.plainText, '° ± ⌀ Ω 🚀 中文 العربية é');
  assert.deepEqual(result.issues, []);
  assert.equal(normalizeDxfText(label({ text: '%%% %%065' })).plainText, '% A');
});

test('MTEXT decodes paragraphs, nonbreaking spaces, grouping and literal escapes in the right order', () => {
  const result = normalizeDxfText(label({ type: 'MTEXT', text: String.raw`{one\Ptwo\~three \{brace\} \\ \U+03A9 \\U+03A9}` }));
  assert.equal(result.plainText, 'one\ntwo\u00a0three {brace} \\ Ω \\U+03A9');
  assert.deepEqual(result.issues, []);
});

test('MTEXT rich styles, stacked fractions and unknown controls remain explicit issues', () => {
  const result = normalizeDxfText(label({ type: 'MTEXT', text: String.raw`{\H2x;Big} \C1;red \S1#2; \Lunder\l \Ztest` }));
  assert.equal(result.plainText, 'Big red 1/2 under \\Ztest');
  assert.ok(result.issues.some(item => item.code === 'DXF_TEXT_INLINE_FORMATTING'));
  assert.ok(result.issues.some(item => item.code === 'DXF_TEXT_STACKED_FRACTION'));
  assert.ok(result.issues.some(item => item.code === 'DXF_TEXT_UNKNOWN_CONTROL'));
  assert.equal(normalizeDxfText(label({ type: 'MTEXT', text: String.raw`\S3^ 4;` })).plainText, '3/4');
});

test('Malformed controls and unresolved fields are retained or reported instead of silently disappearing', () => {
  for (const text of ['{unclosed', 'unmatched}', String.raw`\H2`, 'trailing\\']) {
    assert.ok(normalizeDxfText(label({ type: 'MTEXT', text })).issues.some(item => item.code === 'DXF_TEXT_MALFORMED_FORMATTING'));
  }
  const result = normalizeDxfText(label({ type: 'ATTRIB', text: '%%uName%%u\r\n%<field>% %%233' }));
  assert.equal(result.plainText, 'Name %<field>% é');
  assert.deepEqual(new Set(result.issues.map(item => item.code)), new Set(['DXF_TEXT_MULTILINE', 'DXF_TEXT_INLINE_FORMATTING', 'DXF_TEXT_FIELD', 'DXF_TEXT_LEGACY_CODEPAGE']));
});

test('Canvas absence has an actionable stable error and malformed entities fail validation', () => {
  assert.throws(() => prepareDxfText(label(), { canvasFactory: () => ({ getContext: () => null }) }), error => error.code === 'DXF_TEXT_CANVAS_UNAVAILABLE');
  assert.throws(() => prepareDxfText(label(), { canvasFactory: () => { throw new Error('No canvas'); } }), error => error.code === 'DXF_TEXT_CANVAS_UNAVAILABLE' && error.cause.message === 'No canvas');
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') assert.throws(() => prepareDxfText(label()), error => error.code === 'DXF_TEXT_CANVAS_UNAVAILABLE');
  for (const entity of [label({ height: 0 }), label({ axisX: [1, 0, 0] }), label({ axisX: [0, 0, 0], axisY: [0, 1, 0] }), label({ widthFactor: -1 }), label({ obliqueAngle: 90 }), label({ position: [NaN, 0] }), label({ alignment: 'Unknown' }), label({ type: 'MTEXT', attachmentPoint: 10 })]) {
    assert.throws(() => prepareDxfText(entity, canvasFixture()));
  }
  assert.throws(() => normalizeDxfText(label({ text: 'a'.repeat(100_001) })), error => error.code === 'DXF_TEXT_LIMIT');
});

test('Texture is transparent with white glyphs and each line is a complete shaped Unicode draw', () => {
  const f = canvasFixture();
  const source = 'العربية 中文 é 🚀 ffi';
  const result = prepareDxfText(label({ text: source }), f);
  assert.equal(result.canvas, f.canvas); assert.equal(createDxfTextLayout, prepareDxfText);
  assert.equal(result.plainText, source); assert.equal(result.capHeight, 48);
  assert.deepEqual(f.calls.filter(call => call[0] === 'draw').map(call => call.slice(1, 5)), [[source, 0, 0, '#ffffff']]);
  assert.deepEqual(f.calls.find(call => call[0] === 'clear'), ['clear', 0, 0, result.width, result.height]);
  assert.equal(prepareDxfText(label({ text: 'ffi' }), canvasFixture()).lines[0].width, 70);
});

test('Text basis includes height exactly once and preserves transformed 3D orientation', () => {
  const f = canvasFixture();
  const result = prepareDxfText(label({ height: 100, position: [10, 20, 30], axisX: [0, 2, 0], axisY: [0, 0, 3] }), f);
  assert.equal(result.width, 68); assert.equal(result.height, 52);
  for (const corner of result.corners) assert.equal(corner[0], 10);
  near(result.corners[1][1] - result.corners[0][1], 68 / 48 * 2);
  near(result.corners[0][2] - result.corners[3][2], 52 / 48 * 3);
  const simple = prepareDxfText(label({ height: 2, rotation: 90 }), canvasFixture());
  near(simple.corners[1][0] - simple.corners[0][0], 0);
  near(simple.corners[1][1] - simple.corners[0][1], 68 / 48 * 2);
});

test('TEXT center/right and cap/baseline alignment place the anchor consistently', () => {
  const base = prepareDxfText(label(), canvasFixture());
  for (const [alignment, dx, dy] of [['BaselineCenter', -64 / 96, 0], ['BaselineRight', -64 / 48, 0], ['TopLeft', 0, -1], ['MiddleCenter', -64 / 96, -0.5]]) {
    const result = prepareDxfText(label({ alignment }), canvasFixture());
    result.corners.forEach((corner, index) => { near(corner[0] - base.corners[index][0], dx); near(corner[1] - base.corners[index][1], dy); });
  }
  const middle = prepareDxfText(label({ text: 'g', alignment: 'Middle' }), canvasFixture());
  near((middle.corners[0][1] + middle.corners[3][1]) / 2, 0);
});

test('TEXT Fit scales width and Aligned scales both dimensions to source width/height ratio', () => {
  const normal = prepareDxfText(label(), canvasFixture());
  const fit = prepareDxfText(label({ alignment: 'Fit', width: 4, widthFactor: 2 }), canvasFixture());
  const aligned = prepareDxfText(label({ alignment: 'Aligned', width: 4, widthFactor: 2 }), canvasFixture());
  const width = result => result.corners[1][0] - result.corners[0][0];
  const height = result => result.corners[0][1] - result.corners[3][1];
  near(width(fit), width(normal) * 3); near(height(fit), height(normal));
  near(width(aligned), width(normal) * 3); near(height(aligned), height(normal) * 1.5);
  assert.throws(() => prepareDxfText(label({ alignment: 'Fit' }), canvasFixture()), /positive width/);
});

test('Width factors, oblique shear and text mirror flags affect world corners', () => {
  const normal = prepareDxfText(label(), canvasFixture());
  const wide = prepareDxfText(label({ widthFactor: 2 }), canvasFixture());
  near(wide.corners[1][0] - wide.corners[0][0], (normal.corners[1][0] - normal.corners[0][0]) * 2);
  const oblique = prepareDxfText(label({ obliqueAngle: 45 }), canvasFixture());
  near(oblique.corners[0][0] - oblique.corners[3][0], oblique.corners[0][1] - oblique.corners[3][1]);
  const mirrored = prepareDxfText(label({ isBackward: true, isUpsideDown: true }), canvasFixture());
  mirrored.corners.forEach((corner, i) => { near(corner[0], -normal.corners[i][0]); near(corner[1], -normal.corners[i][1]); });
});

test('MTEXT wraps paragraphs by measured width and obeys DXF line spacing', () => {
  const result = prepareDxfText(label({ type: 'MTEXT', text: String.raw`aa bb cc\Pnext`, width: 3, lineSpacingFactor: 1.5 }), canvasFixture());
  assert.deepEqual(result.lines.map(line => line.text), ['aa bb', 'cc', 'next']);
  assert.deepEqual(result.lines.map(line => line.baseline), [0, 120, 240]);
  const trailingSpace = prepareDxfText(label({ type: 'MTEXT', text: 'aa bb ', width: 3 }), canvasFixture());
  assert.equal(trailingSpace.lines.length, 1);
  const explicitBlank = prepareDxfText(label({ type: 'MTEXT', text: String.raw`aa bb \P`, width: 3 }), canvasFixture());
  assert.equal(explicitBlank.lines.length, 2);
});

test('MTEXT wrap width uses original height scalar and applies widthFactor before wrapping', () => {
  const a = prepareDxfText(label({ type: 'MTEXT', text: 'aa bb cc', height: 2, width: 6, axisX: [10, 0, 0], axisY: [0, 5, 0] }), canvasFixture());
  const b = prepareDxfText(label({ type: 'MTEXT', text: 'aa bb cc', height: 2, width: 6, widthFactor: 2 }), canvasFixture());
  assert.deepEqual(a.lines.map(line => line.text), ['aa bb', 'cc']);
  assert.deepEqual(b.lines.map(line => line.text), ['aa', 'bb', 'cc']);
});

test('MTEXT emergency wrapping keeps combining sequences and surrogate pairs intact', () => {
  const result = prepareDxfText(label({ type: 'MTEXT', text: 'é🚀é🚀', width: 0.7 }), canvasFixture());
  assert.deepEqual(result.lines.map(line => line.text), ['é', '🚀', 'é', '🚀']);
  const nonbreaking = prepareDxfText(label({ type: 'MTEXT', text: String.raw`a\~b`, width: 0.7 }), canvasFixture());
  assert.deepEqual(nonbreaking.lines.map(line => line.text), ['a\u00a0b']);
});

test('All nine MTEXT attachment points anchor the reference rectangle', () => {
  const base = prepareDxfText(label({ type: 'MTEXT', text: String.raw`AB\PCD`, width: 4, attachmentPoint: 1 }), canvasFixture());
  for (let attachmentPoint = 1; attachmentPoint <= 9; attachmentPoint++) {
    const result = prepareDxfText(label({ type: 'MTEXT', text: String.raw`AB\PCD`, width: 4, attachmentPoint }), canvasFixture());
    const dx = -((attachmentPoint - 1) % 3) * 2;
    const dy = Math.floor((attachmentPoint - 1) / 3) * (48 + 80) / 96;
    result.corners.forEach((corner, i) => { near(corner[0] - base.corners[i][0], dx); near(corner[1] - base.corners[i][1], dy); });
  }
});

test('Side-bearing overhangs fit inside transparent padded texture bounds', () => {
  const result = prepareDxfText(label(), canvasFixture({ overhang: 8 }));
  assert.equal(result.width, 84);
  near(result.corners[0][0], -10 / 48);
  near(result.corners[1][0], 74 / 48);
});

test('SHX substitution, unavailable font families and vertical styles are reported', () => {
  const shx = prepareDxfText(label({ fontFile: 'simplex.shx', fontFamily: 'simplex', isVertical: true }), canvasFixture());
  assert.equal(shx.font, '64px sans-serif');
  assert.ok(shx.issues.some(issue => issue.code === 'DXF_TEXT_FONT_SUBSTITUTION' && /simplex.shx/.test(issue.message)));
  assert.ok(shx.issues.some(issue => issue.code === 'DXF_TEXT_VERTICAL_STYLE'));
  const absent = prepareDxfText(label({ fontFamily: 'Nonexistent CAD Font', fontStyle: 'Bold Italic' }), canvasFixture({ missingFont: true }));
  assert.equal(absent.font, 'italic bold 64px sans-serif');
  assert.ok(absent.issues.some(issue => issue.code === 'DXF_TEXT_FONT_SUBSTITUTION'));
  const direction = prepareDxfText(label({ type: 'MTEXT', drawingDirection: 'TopToBottom' }), canvasFixture());
  assert.ok(direction.issues.some(issue => issue.code === 'DXF_TEXT_DRAWING_DIRECTION'));
});

test('Adversarial MTEXT wrapping stops at a fixed browser shaping work budget', () => {
  const f = canvasFixture();
  assert.throws(() => prepareDxfText(label({ type: 'MTEXT', text: 'A'.repeat(10_000), width: 5000 }), f), error => error.code === 'DXF_TEXT_LAYOUT_LIMIT');
  assert.ok(f.calls.filter(call => call[0] === 'measure').length < 4000);
  assert.equal(f.calls.filter(call => call[0] === 'draw').length, 0);
});

test('Oversize labels preserve all content and world size while bounding texture dimensions', () => {
  const source = 'A'.repeat(300), normal = prepareDxfText(label({ text: source }), canvasFixture());
  const result = prepareDxfText(label({ text: source }), { ...canvasFixture(), maxTextureDimension: 128 });
  assert.equal(result.width, 128); assert.ok(result.height <= 128); assert.ok(result.pixelScale < 1);
  assert.equal(result.lines[0].text, source);
  assert.ok(result.issues.some(issue => issue.code === 'DXF_TEXT_TEXTURE_DOWNSAMPLED'));
  near(result.corners[0][0], normal.corners[0][0]); near(result.corners[1][0], normal.corners[1][0]);
  for (const maxTextureDimension of [0, -1, 1.5, Infinity]) assert.throws(() => prepareDxfText(label(), { ...canvasFixture(), maxTextureDimension }), /positive integer/);
});

test('Canvas-free estimate accepts the same transform contract and contains representative measured text', () => {
  for (const entity of [label(), label({ type: 'MTEXT', text: 'Some text\nSecond line', width: 3, attachmentPoint: 9 }), label({ alignment: 'Aligned', width: 10 }), label({ rotation: 45, isBackward: true })]) {
    const corners = estimateDxfTextCorners(entity), measured = prepareDxfText(entity, canvasFixture()).corners;
    for (const point of measured) for (let axis = 0; axis < 3; axis++) {
      assert.ok(point[axis] >= Math.min(...corners.map(p => p[axis])) - 1e-9);
      assert.ok(point[axis] <= Math.max(...corners.map(p => p[axis])) + 1e-9);
    }
  }
});
