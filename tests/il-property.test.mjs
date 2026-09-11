import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeAssembly, compileAssembly } from '../src/il/compiler.mjs';
import { invokeReflectionBuiltin, reflectionType, BindingFlags } from '../src/il/reflection.mjs';
import { i4 } from '../src/il/runtime.mjs';
const model = JSON.parse(await readFile(new URL('./il-property-fixture.json', import.meta.url), 'utf8'));
const call = (runtime, name) => runtime.invoke(`PropertyFixture::${name}`);
const runtime = () => compileAssembly(model, { strict: true });

test('property reflection is based on actual PE metadata and passes strict compatibility checks', () => {
  assert.deepEqual(analyzeAssembly(model).diagnostics, []);
  const type = model.types.find(t => t.name === 'PropertyCounter');
  assert.equal(type.properties.filter(p => p.name === 'Item').length, 2);
  assert.equal(type.properties.find(p => p.name === 'Value').getter.name, 'get_Value');
});

test('C# reflected instance/static property values read and write managed storage', () => {
  const rt = runtime();
  assert.equal(call(rt, 'Instance'), 42);
  assert.equal(call(rt, 'Static'), 42);
});

test('C# indexed property resolution selects exact type signatures and preserves index arguments', () => {
  const rt = runtime();
  assert.equal(call(rt, 'Indexer'), 42);
  assert.equal(call(rt, 'Ambiguous'), 42);
});

test('C# reflection honors public/private accessor queries and nonpublic property selection', () => {
  const rt = runtime();
  assert.equal(call(rt, 'Visibility'), 42);
  assert.equal(call(rt, 'GetterVisibility'), 42);
});

test('C# property reflection follows inherited members and specializes closed generic accessors', () => {
  const rt = runtime();
  assert.equal(call(rt, 'Inherited'), 42);
  assert.equal(call(rt, 'Generic'), 42);
});

test('C# read-only setters throw and reflected property/index/accessor metadata stays available', () => {
  const rt = runtime();
  assert.equal(call(rt, 'ReadOnly'), 42);
  assert.equal(call(rt, 'Metadata'), 'Item:Int32:Int32:2');
});

test('property enumeration applies static/instance/visibility/declared-only flags', () => {
  const rt = runtime(), type = reflectionType(rt, 'PropertyCounter');
  const enumerate = flags => invokeReflectionBuiltin(rt, { declaringType: 'System.Type', name: 'GetProperties', parameters: [{ type: 'System.Reflection.BindingFlags' }], isStatic: false }, [i4(flags)], type).value.items.map(x => x.$member.name);
  assert.deepEqual(enumerate(BindingFlags.Static | BindingFlags.Public), ['Global']);
  const inherited = enumerate(BindingFlags.Instance | BindingFlags.Public);
  assert.ok(inherited.includes('Inherited')); assert.ok(!inherited.includes('Secret'));
  assert.ok(!enumerate(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly).includes('Inherited'));
  assert.deepEqual(enumerate(BindingFlags.Instance | BindingFlags.NonPublic), ['Secret']);
});
