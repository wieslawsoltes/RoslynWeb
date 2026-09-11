import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileAssembly, compileJavaScriptModule, generateModule, generateMethod} from '../src/il/compiler.mjs';
import {buildBasicBlocks, analyzeInt32Method} from '../src/il/optimizer.mjs';
import {decodeNativeValue} from './wasm-native-values.mjs';
import {i4, r8} from '../src/il/runtime.mjs';

const model = JSON.parse(await readFile(new URL('./wasm-native-fixture.json', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('./wasm-native-baseline.json', import.meta.url)));
const modes = [false, 'blocks', true];
const plans = modes.map(optimize => compileJavaScriptModule(model, {optimize}));
const methods = model.types.flatMap(type => type.methods.map(method => ({...method, declaringType: type.name})));
const method = name => methods.find(method => method.name === name);
const simpleModel = methods => ({name: 'OptimizationTests', types: [{name: 'Program', methods}], entryPoint: methods[0].token});
const simple = (body, extra = {}) => ({name: 'Main', token: 1, declaringType: 'Program', isStatic: true, parameters: [], locals: [], returnType: 'System.Int32', body: body.map(([opcode, operand], offset) => ({offset, opcode, operand})), ...extra});

for (const [index, optimize] of modes.entries()) {
  test(`JavaScript optimize=${optimize}: all ${baseline.cases.length} genuine C# cases match native .NET`, () => {
    for (const item of baseline.cases) {
      const runtime = plans[index].createRuntime();
      const invoke = () => runtime.invoke(`NativeNumeric::${item.method}`, item.arguments.map(decodeNativeValue));
      const label = `${item.method}(${item.arguments.map(value => value.value).join(', ')})`;
      if (item.exception) assert.throws(invoke, error => error.$type === item.exception, label);
      else assert.deepEqual(invoke(), decodeNativeValue(item.result), label);
    }
  });
}

test('block plans split real Roslyn control flow and reduce dispatch cases', () => {
  const report = plans[2].optimization;
  assert.ok(report.basicBlocks < report.instructions / 2);
  assert.ok(report.numericMethods >= 20);
  assert.equal(plans[0].optimization.basicBlocks, report.instructions);
  assert.equal(plans[1].optimization.numericMethods, 0);
  assert.ok(analyzeInt32Method(method('Loop')));
  assert.equal(analyzeInt32Method(method('LongLoop')), null);
  assert.equal(analyzeInt32Method(method('CatchDivide')), null);
  const loop = method('Loop'), blocks = buildBasicBlocks(loop);
  for (const instruction of loop.body.filter(instruction => /^b/.test(instruction.opcode))) assert.ok(blocks.some(block => block.offset === instruction.operand));
});

test('optimized loops preserve each IL tick and exact instruction-budget failure offsets', () => {
  const traces = plans.map(plan => {
    const runtime = plan.createRuntime(), offsets = [], tick = runtime.tick.bind(runtime);
    runtime.tick = (frame, offset) => {offsets.push(offset); tick(frame, offset);};
    assert.equal(runtime.invoke('NativeNumeric::Loop', [7]), 112);
    return offsets;
  });
  assert.deepEqual(traces[1], traces[0]); assert.deepEqual(traces[2], traces[0]);
  for (let limit = 1; limit <= traces[0].length; limit++) {
    const outcomes = plans.map(plan => {
      const runtime = plan.createRuntime({maxInstructions: limit});
      try {return {result: runtime.invoke('NativeNumeric::Loop', [7]), count: runtime.instructionCount};}
      catch (error) {return {message: error.message, offset: error.offset, count: runtime.instructionCount};}
    });
    assert.deepEqual(outcomes[1], outcomes[0], `blocks budget ${limit}`);
    assert.deepEqual(outcomes[2], outcomes[0], `numeric budget ${limit}`);
  }
});

test('breakpoint callbacks keep order and can cancel at the original instruction boundary', () => {
  const source = simple([['ldc.i4.1'], ['break'], ['ldc.i4.2'], ['add'], ['ret']]);
  for (const optimize of modes) {
    const controller = new AbortController(), seen = [];
    const runtime = compileAssembly(simpleModel([source]), {optimize, signal: controller.signal, onBreakpoint: ({offset}) => {seen.push(offset); controller.abort();}});
    assert.throws(() => runtime.run(), /aborted/); assert.deepEqual(seen, [1]); assert.equal(runtime.instructionCount, 3);
  }
});

test('malformed or nonnumeric stack flow declines numerical specialization', () => {
  assert.equal(analyzeInt32Method(simple([['add'], ['ret']])), null);
  assert.equal(analyzeInt32Method(simple([['ldloc.0'], ['ret']])), null);
  assert.equal(analyzeInt32Method(simple([['ldc.r8', 1.5], ['ret']])), null);
  assert.equal(analyzeInt32Method(simple([['ldc.i4.1'], ['brtrue', 4], ['ldc.i4.2'], ['br', 5], ['nop'], ['ret']])), null);
});

test('non-i4 raw arguments retain the reference compiler behavior', () => {
  const expected = plans[0].createRuntime().invoke('NativeNumeric::Add', [r8(1.5), r8(2.25)], {raw: true});
  const actual = plans[2].createRuntime().invoke('NativeNumeric::Add', [r8(1.5), r8(2.25)], {raw: true});
  assert.equal(actual.kind, expected.kind); assert.equal(actual.value, expected.value);
});

test('reusable compiled blueprint creates independent static fields and budgets without Function', () => {
  const blueprint = compileJavaScriptModule(model);
  assert.ok(blueprint.generatedSourceBytes > 0);
  const original = globalThis.Function;
  globalThis.Function = () => {throw new Error('Dynamic compilation forbidden after blueprint creation');};
  try {
    const first = blueprint.createRuntime(), second = blueprint.createRuntime();
    assert.notEqual(first.staticFields, second.staticFields);
    first.staticFields.set('fixture isolation sentinel', i4(99));
    assert.equal(second.staticFields.has('fixture isolation sentinel'), false);
    assert.equal(first.invoke('NativeNumeric::Loop', [10]), 330);
    assert.equal(second.instructionCount, 0);
    assert.equal(second.invoke('NativeNumeric::Add', [20, 22]), 42);
  } finally {globalThis.Function = original;}
});

test('generated ES modules preserve optimization and negative-zero constants without dynamic construction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roslynweb-js-optimizer-'));
  try {
    const path = join(directory, 'fixture.mjs');
    await writeFile(path, generateModule(model, {runtimeImport: new URL('../src/il/runtime.mjs', import.meta.url).href}));
    const imported = await import(pathToFileURL(path).href), original = globalThis.Function;
    globalThis.Function = () => {throw new Error('Generated module attempted runtime compilation');};
    try {assert.equal(imported.createAssembly().invoke('NativeNumeric::Loop', [100]), 333300); assert.ok(imported.optimization.numericMethods > 0);}
    finally {globalThis.Function = original;}
    const negativeZero = simple([['ldc.r8', -0], ['ret']], {returnType: 'System.Double'});
    assert.equal(Object.is(compileAssembly(simpleModel([negativeZero])).run(), -0), true);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('filter entry callbacks share locals and restore the suspended evaluation stack', () => {
  const target = simple([['ldc.i4.1'], ['ldc.i4.0'], ['div'], ['ret'], ['pop'], ['ldc.i4.7'], ['stloc.0'], ['ldc.i4.1'], ['endfilter'], ['pop'], ['ldloc.0'], ['ret']], {locals: ['System.Int32'], exceptionHandlers: [{kind: 'filter', tryOffset: 0, tryLength: 4, filterOffset: 4, handlerOffset: 9, handlerLength: 3}]});
  assert.match(generateMethod(target), /evaluateFilter/);
  for (const optimize of modes) {
    const runtime = compileAssembly(simpleModel([target]), {optimize}), frame = runtime.frame.bind(runtime); let captured;
    runtime.frame = (...args) => captured = frame(...args);
    assert.equal(runtime.run(), 7);
    const stack = captured.stack, offset = captured.offset;
    captured.locals[0] = i4(0);
    assert.equal(captured.evaluateFilter(4, new Error('fixture')), true);
    assert.equal(captured.locals[0].value, 7); assert.equal(captured.stack, stack); assert.equal(captured.offset, offset);
  }
});

test('Object.GetHashCode is admitted for its exact instance signature and has stable runtime identity', () => {
  const runtime = plans[2].createRuntime();
  const ref = {declaringType: 'System.Object', name: 'GetHashCode', isStatic: false, parameters: [], returnType: 'System.Int32'};
  const object = {$type: 'System.Object', fields: {}};
  const first = runtime.callBuiltin(ref, [], object, 'callvirt').value.value;
  assert.equal(runtime.callBuiltin(ref, [], object, 'callvirt').value.value, first);
  assert.equal(runtime.callBuiltin(ref, [], {$type: 'System.Int32', $box: true, value: i4(42)}, 'callvirt').value.value, 42);
  assert.equal(runtime.objectHashCode(r8(-0)).value, runtime.objectHashCode(r8(0)).value);
});
