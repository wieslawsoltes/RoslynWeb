import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compileAssembly, isBuiltinCandidate } from '../src/il/compiler.mjs';
import { ILRuntime, i4 } from '../src/il/runtime.mjs';
import { compileWasm, loadWasm } from '../src/wasm/index.js';
import { expandArgumentExceptionResources } from './argument-exceptions-oracle.mjs';

const model = JSON.parse(await readFile(new URL('./argument-exceptions-fixture.json', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('./argument-exceptions-baseline.json', import.meta.url)));
const types = ['System.ArgumentException', 'System.ArgumentNullException', 'System.ArgumentOutOfRangeException'];
const ref = (declaringType, name, parameters = [], returnType = 'System.Void') => ({
    declaringType, name, parameters: parameters.map(type => ({ type })), returnType, isStatic: false,
});

test('argument-exception oracle preserves raw .NET WASM results and authenticates source', async () => {
    const source = await readFile(new URL('./argument-exceptions-fixture.cs', import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), baseline.sourceSha256);
    assert.equal(baseline.runtime, '10.0.0');
    assert.equal(baseline.roslynVersion, '5.0.0.0');
    assert.equal(baseline.cases.length, 6);
    for (const item of baseline.cases) assert.equal(item.result, expandArgumentExceptionResources(item.rawResult));
    assert(baseline.cases.find(item => item.method === 'MutableActualValue').rawResult.includes('value:7'));
    assert(baseline.cases.find(item => item.method === 'MutableActualValue').rawResult.includes('value:9'));
});

for (const optimize of [false, 'blocks', true]) {
    test(`argument constructors, defaults, properties and lazy actual-value formatting match .NET in JavaScript optimize=${optimize}`, () => {
        const runtime = compileAssembly(model, { optimize, strict: true, exports: baseline.cases.map(item => item.method) });
        for (const item of baseline.cases) assert.equal(runtime.invoke(`ArgumentExceptionsFixture::${item.method}`), item.result, item.method);
    });
}

for (const optimize of [false, true]) {
    test(`argument constructors and implicit ToString callback execute in native Wasm optimize=${optimize}`, async () => {
        const artifact = compileWasm(model, { optimize, exports: baseline.cases.map(item => item.method) });
        assert.equal(WebAssembly.validate(artifact.bytes), true);
        assert(artifact.manifest.methods.some(method => (method.type ?? method.declaringType) === 'ArgumentExceptionsFixture+MutableValue' && method.name === 'ToString'));
        const runtime = await loadWasm(artifact.bytes);
        try {
            for (const item of baseline.cases) assert.equal(runtime.invoke(`ArgumentExceptionsFixture::${item.method}`), item.result, item.method);
        } finally { runtime.dispose(); }
    });
}

test('argument-exception classifier and runtime reject unsupported signatures', () => {
    const runtime = new ILRuntime({ name: 'UnsupportedArgumentSignatures', types: [] });
    const invalid = [];
    for (const type of types) {
        invalid.push(ref(type, '.ctor', ['System.Int32']));
        invalid.push(ref(type, '.ctor', ['System.String', 'System.Object']));
        invalid.push(ref(type, '.ctor', ['System.String', 'System.String', 'System.String']));
        invalid.push(ref(type, '.ctor', ['System.Runtime.Serialization.SerializationInfo', 'System.Runtime.Serialization.StreamingContext']));
        invalid.push({ ...ref(type, '.ctor'), isStatic: true });
        invalid.push(ref(type, '.ctor', [], 'System.String'));
        invalid.push({ ...ref(type, '.ctor'), genericArguments: ['System.Int32'] });
        invalid.push(ref(type, 'get_ParamName', [], 'System.Object'));
        invalid.push(ref(type, 'get_Message', [], 'System.Int32'));
        invalid.push(ref(type, 'get_InnerException', ['System.String'], 'System.Exception'));
    }
    invalid.push(ref(types[0], 'get_ActualValue', [], 'System.Object'));
    invalid.push(ref(types[1], 'get_ActualValue', [], 'System.Object'));
    invalid.push(ref(types[1], '.ctor', ['System.String', 'System.String', 'System.Exception']));
    invalid.push(ref(types[2], '.ctor', ['System.String', 'System.String', 'System.Exception']));
    for (const method of invalid) {
        assert.equal(isBuiltinCandidate(method), false, JSON.stringify(method));
        assert.equal(runtime.callBuiltin(method, method.parameters.map(() => null), runtime.allocate(method.declaringType), 'call').handled, false, JSON.stringify(method));
    }
});

test('argument exception constructors retain actual value and inner exception identity', () => {
    const runtime = new ILRuntime({ name: 'ArgumentIdentity', types: [] });
    const actual = runtime.box(i4(42), 'System.Int32');
    const range = runtime.allocate(types[2]);
    const constructor = ref(types[2], '.ctor', ['System.String', 'System.Object', 'System.String']);
    assert.equal(isBuiltinCandidate(constructor), true);
    assert.equal(runtime.callBuiltin(constructor, ['radius', actual, 'Invalid radius.'], range, 'newobj').handled, true);
    assert.equal(runtime.callBuiltin(ref(types[2], 'get_ActualValue', [], 'System.Object'), [], range, 'call').value, actual);
    assert.equal(runtime.callBuiltin(ref(types[0], 'get_ParamName', [], 'System.String'), [], range, 'call').value, 'radius');
    assert.equal(range.message, "Invalid radius. (Parameter 'radius')\nActual value was 42.");
    const argument = runtime.allocate(types[0]);
    runtime.callBuiltin(ref(types[0], '.ctor', ['System.String', 'System.String', 'System.Exception']), ['outer', 'radius', range], argument, 'newobj');
    assert.equal(runtime.callBuiltin(ref(types[0], 'get_InnerException', [], 'System.Exception'), [], argument, 'call').value, range);
    assert.equal(argument.message, "outer (Parameter 'radius')");
});
