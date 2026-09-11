import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileAssembly, compileJavaScriptModule, generateModule} from '../src/il/compiler.mjs';
import {analyzeInt32Method, analyzeNumericMethod} from '../src/il/optimizer.mjs';
import {i4, i8, r4, r8, floatLiteral} from '../src/il/runtime.mjs';
import {integerToSingle} from '../src/il/integer-float.mjs';

const model = JSON.parse(await readFile(new URL('./wasm-native-fixture.json', import.meta.url)));
const methods = model.types.flatMap(type => type.methods.map(method => ({...method, declaringType: type.name})));
const method = name => methods.find(method => method.name === name);
const plans = [false, 'blocks', true].map(optimize => compileJavaScriptModule(model, {optimize}));
const simple = (body, extra = {}) => ({name: 'Main', token: 1, declaringType: 'Program', isStatic: true, parameters: [], locals: [], returnType: 'System.Int64', body: body.map(([opcode, operand], offset) => ({offset, opcode, operand})), ...extra});
const simpleModel = method => ({name: 'NumericOptimization', types: [{name: 'Program', methods: [method]}], entryPoint: method.token});
const output = callback => {try {const value = callback(); return {value};} catch (error) {return {type: error.$type, message: error.message, offset: error.offset};}};

test('real Roslyn wide and floating kernels have proven unboxed plans', () => {
  for (const name of ['LongLoop', 'LongAdd', 'LongMultiply', 'LongDivide', 'LongShift', 'ULongShift', 'LongCompare', 'ULongCompare',
    'WidenUnsigned', 'Narrow', 'DoubleArithmetic', 'SingleArithmetic', 'DoubleCompare', 'ULongToDouble', 'DoubleToLong', 'CheckedLongMultiply']) {
    const target = method(name), plan = analyzeNumericMethod(target);
    assert.ok(plan, name); assert.equal(analyzeInt32Method(target), null, name);
    for (const block of plan.blocks) assert.ok(plan.stacks.has(block.offset), `${name} IL_${block.offset}`);
  }
  assert.ok(plans[2].optimization.numericMethods >= 70);
  assert.equal(plans[0].optimization.numericMethods, 0); assert.equal(plans[1].optimization.numericMethods, 0);
});

test('the wide hot loop avoids arithmetic, conversion and intermediate Numeric allocations', () => {
  const runtime = plans[2].createRuntime(); let boxed = 0;
  const box = runtime.i8;
  runtime.i8 = value => {boxed++; return box(value);};
  runtime.binary = runtime.convert = () => {throw new Error('Unexpected boxed hot-path operation');};
  assert.equal(runtime.invoke('NativeNumeric::LongLoop', [1000]), 333333000n);
  assert.equal(boxed, 1, 'only the public managed result needs an Int64 wrapper');
});

test('floating hot arithmetic avoids Numeric allocation until returning its result', () => {
  for (const [name, factory, kind] of [['SingleArithmetic', r4, 'r4'], ['DoubleArithmetic', r8, 'r8']]) {
    const runtime = plans[2].createRuntime(); let boxed = 0; const box = runtime[kind];
    runtime[kind] = value => {boxed++; return box(value);};
    runtime.binary = () => {throw new Error('Unexpected boxed hot-path operation');};
    const args = [factory(1.25), factory(3.125)];
    assert.deepEqual(runtime.invoke(`NativeNumeric::${name}`, args, {raw: true}), plans[0].createRuntime().invoke(`NativeNumeric::${name}`, args, {raw: true}));
    assert.equal(boxed, 1);
  }
});

test('typed stack proof declines invalid and uncertain control flow', () => {
  const invalid = [
    simple([['add'], ['ret']]),
    simple([['ldloc.0'], ['ret']]),
    simple([['ldc.i4.1'], ['ret']]),
    simple([['ldc.i8', '1'], ['ldc.i4.1'], ['add'], ['ret']]),
    simple([['ldc.i4.1'], ['brtrue', 5], ['ldc.i8', '1'], ['br', 6], ['nop'], ['ldc.i4.1'], ['ret']]),
    simple([['br', 99], ['ldc.i8', '0'], ['ret']]),
    simple([['ldc.i8', '0'], ['stloc.0'], ['ldloc.0'], ['ret']], {locals: ['System.Double']}),
    simple([['ldc.i8', '0'], ['ret']], {isStatic: false}),
    simple([['ldc.i8', '0'], ['ret']], {genericParameters: ['T']}),
    simple([['ldc.i8', '0'], ['ret']], {exceptionHandlers: [{kind: 'finally', tryOffset: 0, tryLength: 1, handlerOffset: 1, handlerLength: 1}]}),
    simple([['ldc.i8', '0'], ['ret']], {parameters: ['System.Int64&']}),
    simple([['ldc.i8', '0'], ['ret'], ['call', {}]]),
    simple([['ldc.r8', NaN], ['ret']], {returnType: 'System.Double'}),
    simple([['ldc.r4', 1], ['not'], ['ret']], {returnType: 'System.Single'}),
    simple([['ldc.i4.1'], ['brtrue', 5], ['ldc.r4', 1], ['br', 6], ['nop'], ['ldc.r8', 1], ['ret']], {returnType: 'System.Double'}),
  ];
  const duplicate = simple([['ldc.i8', '0'], ['ret']]); duplicate.body[1].offset = 0; invalid.push(duplicate);
  for (const [index, target] of invalid.entries()) assert.equal(analyzeNumericMethod(target), null, `invalid plan ${index}`);
});

test('checked wide arithmetic, division and conversions retain exact CLR exceptions', () => {
  const cases = [
    ['LongDivide', [-9223372036854775808n, -1n]], ['LongRemainder', [-9223372036854775808n, -1n]],
    ['LongDivide', [123n, 0n]], ['ULongDivide', [18446744073709551615n, 0n]],
    ['CheckedLongMultiply', [9223372036854775807n, 2n]], ['CheckedULongAdd', [18446744073709551615n, 1n]],
    ['CheckedNarrow', [2147483648n]], ['CheckedDoubleToLong', [Infinity]], ['CheckedDoubleToULong', [-1]],
  ];
  for (const [name, args] of cases) {
    const expected = output(() => plans[0].createRuntime().invoke(`NativeNumeric::${name}`, args));
    assert.ok(expected.type?.startsWith('System.'), name);
    assert.deepEqual(output(() => plans[2].createRuntime().invoke(`NativeNumeric::${name}`, args)), expected, name);
  }
});

test('non-finite floating operands and results preserve IEEE comparisons and signed zero', () => {
  const values = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Infinity, -Infinity, NaN];
  for (const name of ['DoubleArithmetic', 'SingleArithmetic', 'DoubleDivide', 'DoubleRemainder', 'SingleRemainder', 'DoubleCompare']) {
    for (const a of values) for (const b of values) {
      const expected = output(() => plans[0].createRuntime().invoke(`NativeNumeric::${name}`, [a, b]));
      assert.deepEqual(output(() => plans[2].createRuntime().invoke(`NativeNumeric::${name}`, [a, b])), expected, `${name}(${a},${b})`);
    }
  }
});

test('wide conversions and shifts never round through a JS Number', () => {
  const values = [-9223372036854775808n, -9007199254740993n, -4294967297n, -1n, 0n, 9007199254740993n, 9223372036854775807n];
  for (const value of values) {
    for (const bits of [-2147483648, -65, -64, -1, 0, 1, 31, 32, 63, 64, 65, 2147483647]) {
      for (const name of ['LongShift', 'ULongShift']) assert.equal(plans[2].createRuntime().invoke(`NativeNumeric::${name}`, [value, bits]), plans[0].createRuntime().invoke(`NativeNumeric::${name}`, [value, bits]), `${name}(${value},${bits})`);
    }
    assert.equal(plans[2].createRuntime().invoke('NativeNumeric::Narrow', [value]), plans[0].createRuntime().invoke('NativeNumeric::Narrow', [value]));
  }
  assert.equal(plans[2].createRuntime().invoke('NativeNumeric::WidenUnsigned', [4294967295]), 4294967295n);
});

test('integer-to-Single rounds directly with ties to even and sign symmetry', () => {
  const data = new DataView(new ArrayBuffer(4));
  const bits = value => {data.setFloat32(0, value, true); return data.getUint32(0, true);};
  // These Single patterns are independently recorded by the native CLR oracle.
  for (const [value, expected] of [[4611686293305294849n, 0x5e800001], [9223372586610589697n, 0x5f000001], [18446743523953737727n, 0x5f7fffff]]) {
    assert.equal(bits(integerToSingle(value)), expected);
    assert.equal(bits(integerToSingle(-value)), (expected | 0x80000000) >>> 0);
    assert.notEqual(bits(Math.fround(Number(value))), expected, 'fixture exposes double rounding');
  }
  for (const exponent of [24, 31, 53, 62, 63, 100]) {
    const spacing = 1n << BigInt(exponent - 23), base = 1n << BigInt(exponent), half = spacing / 2n;
    for (const [value, expected] of [[base + half, base], [base + half + 1n, base + spacing], [base + spacing + half, base + 2n * spacing]]) {
      assert.equal(integerToSingle(value), Number(expected));
      assert.equal(integerToSingle(-value), -Number(expected));
    }
  }
  assert.equal(integerToSingle(0n), 0);
  assert.equal(integerToSingle(1n << 128n), Infinity); assert.equal(integerToSingle(-(1n << 128n)), -Infinity);
  assert.equal(integerToSingle((1n << 128n) - (1n << 104n)), Math.fround(3.4028234663852886e38));
});

test('wrong-kind raw arguments preserve the reference path', () => {
  for (const [name, args] of [['LongAdd', [r8(1.5), r8(2.25)]], ['DoubleArithmetic', [i4(3), i4(7)]], ['SingleArithmetic', [r8(1.0000000001), r8(2.5)]], ['LongShift', [i4(123), i8(4)]]]) {
    assert.deepEqual(output(() => plans[2].createRuntime().invoke(`NativeNumeric::${name}`, args, {raw: true})), output(() => plans[0].createRuntime().invoke(`NativeNumeric::${name}`, args, {raw: true})), name);
  }
});

test('NaN provenance remains bit-exact through numeric identity and negation', () => {
  for (const [kind, type, patterns] of [['r4', 'System.Single', [0x7f800001n, 0xffc12345n]], ['r8', 'System.Double', [0x7ff0000000000001n, 0xfff8123456789abcn]]]) {
    for (const negate of [false, true]) {
      const target = simple([['ldarg.0'], ...(negate ? [['neg']] : []), ['ret']], {parameters: [type], returnType: type});
      assert.ok(analyzeNumericMethod(target));
      const reference = compileAssembly(simpleModel(target), {optimize: false}), optimized = compileAssembly(simpleModel(target));
      for (const bits of patterns) {
        const input = floatLiteral(kind, bits), actual = optimized.invoke(1, [input], {raw: true}), expected = reference.invoke(1, [input], {raw: true});
        assert.equal(actual.floatBits, expected.floatBits); assert.equal(actual.kind, expected.kind);
        assert.ok(Number.isNaN(actual.value));
      }
    }
  }
});

test('wide and floating instruction budgets fail at the exact original IL boundary', () => {
  for (const [name, args] of [['LongLoop', [3]], ['SingleArithmetic', [1.25, 2.5]], ['DoubleToLong', [1e20]], ['LongDivide', [7n, 0n]]]) {
    const baselineRuntime = plans[0].createRuntime(); output(() => baselineRuntime.invoke(`NativeNumeric::${name}`, args));
    for (let limit = 1; limit <= baselineRuntime.instructionCount + 1; limit++) {
      const outcomes = [plans[0], plans[2]].map(plan => {
        const runtime = plan.createRuntime({maxInstructions: limit});
        return {...output(() => runtime.invoke(`NativeNumeric::${name}`, args)), count: runtime.instructionCount, frames: runtime.exceptionFrames.length};
      });
      assert.deepEqual(outcomes[1], outcomes[0], `${name} budget ${limit}`);
    }
  }
});

test('custom ticks observe the same wide frame stack and locals as reference execution', () => {
  const traces = [plans[0], plans[2]].map(plan => {
    const runtime = plan.createRuntime(), tick = runtime.tick.bind(runtime), trace = [];
    runtime.tick = (frame, offset) => {trace.push({offset, stack: structuredClone(frame.stack), locals: structuredClone(frame.locals)}); tick(frame, offset);};
    assert.equal(runtime.invoke('NativeNumeric::LongLoop', [3]), 8n);
    return trace;
  });
  assert.deepEqual(traces[1], traces[0]);
});

test('an already aborted signal stops typed arithmetic before execution', () => {
  const controller = new AbortController(); controller.abort();
  for (const name of ['LongLoop', 'DoubleArithmetic']) {
    const args = name === 'LongLoop' ? [100] : [1.5, 2.5];
    const results = [plans[0], plans[2]].map(plan => {
      const runtime = plan.createRuntime({signal: controller.signal});
      return {...output(() => runtime.invoke(`NativeNumeric::${name}`, args)), count: runtime.instructionCount, frames: runtime.exceptionFrames.length};
    });
    assert.deepEqual(results[1], results[0]); assert.match(results[1].message, /aborted/);
  }
});

test('ckfinite keeps managed arithmetic exceptions and original offsets', () => {
  const target = simple([['ldarg.0'], ['ckfinite'], ['ret']], {parameters: ['System.Double'], returnType: 'System.Double'});
  assert.ok(analyzeNumericMethod(target));
  for (const value of [1.5, -0, Infinity, -Infinity, NaN]) {
    const outcomes = [false, true].map(optimize => output(() => compileAssembly(simpleModel(target), {optimize}).invoke(1, [value])));
    assert.deepEqual(outcomes[1], outcomes[0]);
    if (!Number.isFinite(value)) assert.equal(outcomes[1].type, 'System.ArithmeticException');
  }
});

test('saved modules execute typed kernels without dynamic Function construction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roslynweb-numeric-module-'));
  try {
    const path = join(directory, 'numeric.mjs');
    await writeFile(path, generateModule(model, {runtimeImport: new URL('../src/il/runtime.mjs', import.meta.url).href}));
    const module = await import(pathToFileURL(path).href), original = globalThis.Function;
    globalThis.Function = () => {throw new Error('Dynamic Function construction is disabled');};
    try {
      const runtime = module.createAssembly();
      assert.equal(runtime.invoke('NativeNumeric::LongLoop', [1000]), 333333000n);
      assert.equal(runtime.invoke('NativeNumeric::SingleArithmetic', [1.25, 2.5]), Math.fround(-1.5625));
      assert.equal(runtime.invoke('NativeNumeric::DoubleDivide', [-0, 3]), -0);
    } finally {globalThis.Function = original;}
  } finally {await rm(directory, {recursive: true, force: true});}
});
