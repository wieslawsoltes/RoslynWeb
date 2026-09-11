import test from 'node:test';
import assert from 'node:assert/strict';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm, loadWasm} from '../src/wasm/index.js';

const value = 4611686293305294849n;
const bits = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
// Independently verified with native .NET 10 DynamicMethod methods containing
// these exact opcode sequences. Even a nop between conv.r.un and conv.r4 ends
// the direct conversion pattern; an explicit double conversion must round twice.
const barriers = new Map([
  ['adjacent', []],
  ['nop', [['nop']]],
  ['explicit double', [['conv.r8']]],
  ['double local', [['stloc.0'], ['ldloc.0']]],
  ['duplicate and discard', [['dup'], ['pop']]],
  ['branch', [['br.s', 3]]],
  ['floating arithmetic', [['ldc.r8', 0], ['add']]],
  ['duplicate and store', [['dup'], ['stloc.0']]],
]);
function modelFor(barrier) {
  const body = [['ldarg.0'], ['conv.r.un'], ...barrier, ['conv.r4'], ['ret']]
    .map(([opcode, operand], offset) => ({offset, opcode, operand}));
  return {name:'ConversionBarriers', types:[{name:'Program', methods:[{
    name:'Convert', token:0x06000001, isStatic:true, parameters:[{type:'System.UInt64'}],
    returnType:'System.Single', locals:[{type:'System.Double'}], body,
  }]}]};
}
for (const [name, barrier] of barriers) {
  test(`integer-to-Single conversion respects ${name} rounding boundary`, async () => {
    const model = modelFor(barrier), expected = name === 'adjacent' ? 0x5e800001 : 0x5e800000;
    for (const optimize of [false, 'blocks', true]) {
      const runtime = compileAssembly(model, {optimize});
      assert.equal(bits(runtime.invoke('Program::Convert', [value])), expected, `JavaScript optimize=${optimize}`);
    }
    for (const optimize of [false, true]) {
      const artifact = compileWasm(model, {optimize});
      assert.equal(artifact.imports.length, 0);
      const runtime = await loadWasm(artifact.bytes);
      assert.equal(bits(runtime.invoke('Program::Convert', [value])), expected, `Wasm optimize=${optimize}`);
    }
  });
}

test('adjacent unsigned-to-Single conversion preserves every JavaScript instruction budget boundary', () => {
  const model = modelFor([]);
  for (let limit = 1; limit <= 4; limit++) {
    const outcomes = [false, 'blocks', true].map(optimize => {
      const runtime = compileAssembly(model, {optimize, maxInstructions:limit});
      try { return {bits:bits(runtime.invoke('Program::Convert', [value])), count:runtime.instructionCount}; }
      catch (error) { return {message:error.message, offset:error.offset, count:runtime.instructionCount}; }
    });
    assert.deepEqual(outcomes[1], outcomes[0], `blocks budget ${limit}`);
    assert.deepEqual(outcomes[2], outcomes[0], `numeric budget ${limit}`);
    if (limit === 4) assert.equal(outcomes[0].bits, 0x5e800001);
    else assert.equal(outcomes[0].offset, limit);
  }
});

test('a branch entering conv.r4 bypasses unsigned provenance from another predecessor', async () => {
  const model = modelFor([]), method = model.types[0].methods[0];
  method.parameters.push({type:'System.Double'}, {type:'System.Boolean'});
  method.body = [['ldarg.2'], ['brtrue.s', 6], ['ldarg.0'], ['conv.r.un'], ['conv.r4'], ['ret'], ['ldarg.1'], ['br.s', 4]]
    .map(([opcode, operand], offset) => ({offset, opcode, operand}));
  // Native DynamicMethod yields exact integer conversion on the first edge and
  // the independently supplied Double on the edge entering the second opcode.
  for (const optimize of [false, 'blocks', true]) {
    const runtime = compileAssembly(model, {optimize});
    assert.equal(bits(runtime.invoke('Program::Convert', [value, 1.5, false])), 0x5e800001);
    assert.equal(bits(runtime.invoke('Program::Convert', [value, 1.5, true])), 0x3fc00000);
  }
  for (const optimize of [false, true]) {
    const artifact = compileWasm(model, {optimize}), runtime = await loadWasm(artifact.bytes);
    assert.equal(artifact.imports.length, 0);
    assert.equal(bits(runtime.invoke('Program::Convert', [value, 1.5, false])), 0x5e800001);
    assert.equal(bits(runtime.invoke('Program::Convert', [value, 1.5, true])), 0x3fc00000);
  }
});
