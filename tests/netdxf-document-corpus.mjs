// Canonical corpus and semantic contract shared by execution and CI aggregation.
import assert from 'node:assert/strict';

const versions = [2000, 2004, 2007, 2010, 2013, 2018];
const versionCodes = ['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032'];
const profiles = [
  {name: 'legacy', layer: 'Prüfung € étage', text: 'Résumé £ µ — café'},
  {name: 'unicode', layer: 'Zażółć 中文 Ω 😀', text: 'Zażółć gęślą jaźń 中文 Ω 😀'},
];
export const documentCases = versions.flatMap((year, index) => [false, true].flatMap(binary => profiles.map(profile => ({
  ...profile, year, binary, code: versionCodes[index],
  id: `${year}-${binary ? 'binary' : 'ascii'}-${profile.name}`,
  label: `${year} ${binary ? 'binary' : 'ASCII'} ${profile.name}`,
}))));
const pointFields = prefix => ['x', 'y', 'z'].map(axis => `${prefix}.${axis}`);
const entityFields = prefix => ['type', 'layer.name', 'layer.colorIndex'].map(field => `${prefix}.${field}`);
export const signatureFields = [
  'version', 'entities.count', 'layers.count', 'lines.count', 'circles.count', 'arcs.count',
  'polylines.count', 'texts.count', 'mtexts.count',
  ...entityFields('line'), ...pointFields('line.start'), ...pointFields('line.end'), 'line.thickness', 'line.linetypeScale',
  ...entityFields('circle'), ...pointFields('circle.center'), 'circle.radius',
  ...entityFields('arc'), ...pointFields('arc.center'), 'arc.radius', 'arc.startAngle', 'arc.endAngle',
  ...entityFields('polyline'), 'polyline.closure', 'polyline.elevation', 'polyline.thickness', 'polyline.vertices.count',
  ...Array.from({length: 4}, (_, index) => ['x', 'y', 'bulge', 'startWidth', 'endWidth']
    .map(field => `polyline.vertices[${index}].${field}`)).flat(),
  ...entityFields('text'), 'text.value', ...pointFields('text.position'), 'text.height', 'text.rotation', 'text.widthFactor',
  ...entityFields('mtext'), 'mtext.value', ...pointFields('mtext.position'), 'mtext.height', 'mtext.rectangleWidth', 'mtext.rotation',
];
assert.equal(signatureFields.length, expectedSignature(documentCases[0]).length, 'Signature schema and expected fields must agree.');

export function expectedSignature(item) {
  const layer = item.layer;
  return [
    `AutoCad${item.year}`, 6, 2, 1, 1, 1, 1, 1, 1,
    'LINE', layer, 3, 1.25, -2.5, 3.75, 1000.125, 20.5, -6.25, 0.375, 2.5,
    'CIRCLE', layer, 3, 4.25, 5.5, 6.75, 2.125,
    'ARC', layer, 3, -10.5, 3.125, -4.25, 7.75, 350, 25.5,
    'LWPOLYLINE', layer, 3, 'closed', 2.25, 0.5, 4,
    0, 0, 0.5, 0.25, 0.75,
    10.25, 0, 0, 0, 0,
    10.25, 5.5, -0.125, 0, 0,
    0, 5.5, 0, 0, 0,
    'TEXT', layer, 3, item.text, -3.25, 4.5, 1.75, 2.5, 27.5, 0.875,
    'MTEXT', layer, 3, `${item.text}\\PSecond paragraph 123`, 7.25, -8.5, 2.75, 1.25, 30.5, 12.5,
  ];
}

export function assertSignature(actual, expected, label) {
  assert(Array.isArray(actual), `${label}: signature must be an array`);
  assert.equal(actual.length, expected.length, `${label}: semantic field count`);
  for (let index = 0; index < expected.length; index++) {
    const field = `${label}: ${signatureFields[index]} [${index}]`;
    if (typeof expected[index] === 'number') {
      assert.equal(typeof actual[index], 'string', `${field}: fixture returns numeric strings`);
      assert.notEqual(actual[index].trim(), '', `${field}: missing numeric value`);
      const value = Number(actual[index]);
      assert(Number.isFinite(value), `${field}: non-finite value ${actual[index]}`);
      assert(Math.abs(value - expected[index]) <= 1e-11 * Math.max(1, Math.abs(expected[index])),
        `${field}: ${value} != ${expected[index]}`);
    } else {
      assert.equal(actual[index], expected[index], field);
    }
  }
}

export const semanticSignature = {
  fields: signatureFields.map((name, index) => ({name, type: typeof expectedSignature(documentCases[0])[index]})),
  numericRelativeTolerance: 1e-11,
  numericAbsoluteTolerance: 1e-11,
  strings: 'Exact ordinal equality, including layer identifiers and complete TEXT/MTEXT payloads.',
  excludedVolatileFields: ['handles', 'timestamps', 'comments'],
  checks: ['version', 'entity counts', 'layer counts/names/colors', 'line endpoints/thickness/linetype scale',
    'circle center/radius', 'arc center/radius/angles', 'polyline closure/elevation/thickness/vertices/bulges/widths',
    'TEXT and MTEXT values/positions/heights/rotations/widths'],
};
