import test from 'node:test';
import assert from 'node:assert/strict';
import {ILRuntime} from '../src/il/runtime.mjs';
import {compileWasm, loadWasm} from '../src/wasm/index.js';

const int = 'System.Int32';
const str = 'System.String';
const method = (token, name, parameters = [], extra = {}) => ({
  token: 0x06000000 + token, name, isStatic: true, returnType: int,
  parameters: parameters.map(type => ({type})), ...extra,
});
const type = (name, methods, extra = {}) => ({name, fields: [], methods, ...extra});
const reference = (declaringType, name, parameters = [], extra = {}) => ({
  declaringType, name, parameters: parameters.map(type => ({type})), ...extra,
});

test('framework misses do not repeatedly enumerate linked method metadata', () => {
  const runtime = new ILRuntime({name: 'Large', types: Array.from({length: 4000}, (_, index) =>
    type(`Unrelated${index}`, [method(index + 1, 'ReadByte')]))});
  const values = runtime.methods.values.bind(runtime.methods);
  let enumerations = 0;
  runtime.methods.values = function() { enumerations++; return values(); };
  assert.equal(runtime.resolveMethod(reference('System.IO.BinaryReader', 'ReadByte')), null);
  assert.equal(enumerations, 1);
  enumerations = 0;
  for (let index = 0; index < 1000; index++) {
    assert.equal(runtime.resolveMethod(reference('System.IO.BinaryReader', 'ReadByte')), null);
    assert.equal(runtime.resolveMethod(reference('Unrelated0', `Missing${index}`)), null);
  }
  assert.equal(enumerations, 0, 'Repeated framework calls must not scan every linked method.');
});

test('closed generic owners retain overload and generic method arity matching', () => {
  const runtime = new ILRuntime({name: 'Generics', types: [type('Owner`1', [
    method(1, 'Choose', ['!0']),
    method(2, 'Choose', ['!0'], {genericParameters: ['U']}),
    method(3, 'Choose', [str]),
  ], {genericParameters: ['T']})]});
  const plain = runtime.resolveMethod(reference(`Owner\`1<${int}>`, 'Choose', [int]));
  assert.equal(plain.token, 0x06000001);
  assert.deepEqual(plain.parameters, [{type: int}]);
  assert.equal(plain.declaringType, `Owner\`1<${int}>`);
  const generic = runtime.resolveMethod(reference(`Owner\`1<${int}>`, 'Choose', [int], {genericArguments: [str]}));
  assert.equal(generic.token, 0x06000002);
  assert.deepEqual(generic.$methodArguments, [str]);
  assert.equal(runtime.resolveMethod(reference(`Owner\`1<${int}>`, 'Choose', [str])).token, 0x06000003);
  assert.equal(runtime.resolveMethod(reference(`Owner\`1<${int}>`, 'Choose', [int], {genericArguments: [str, int]})), null);
  assert.equal(runtime.resolveMethod(reference(`Other\`1<${int}>`, 'Choose', [int])), null);
});

test('fallback candidates preserve metadata insertion order and name ambiguity', () => {
  const runtime = new ILRuntime({name: 'Duplicates', types: [type('Owner`1', [
    method(7, 'Choose', ['!0']), method(3, 'Choose', ['!0']),
  ], {genericParameters: ['T']})]});
  // There is no exact closed-owner key. The existing signature matcher chooses
  // the first matching metadata entry, even when tokens have a different order.
  assert.equal(runtime.resolveMethod(reference(`Owner\`1<${int}>`, 'Choose', [int])).token, 0x06000007);
  assert.throws(() => runtime.resolveMethod('Choose'), /ambiguous/);
});

test('token and exact signature lookup precedence is unchanged', () => {
  const runtime = new ILRuntime({name: 'Direct', types: [
    type('First', [method(1, 'Choose', [int]), method(2, 'Choose', [str])]),
    type('Second', [method(3, 'Choose', [int])]),
  ]});
  const token = runtime.resolveMethod(reference('First', 'Choose', [str], {token: 0x06000001}));
  assert.equal(token.token, 0x06000001, 'A matching owner and MethodDef token remain authoritative.');
  assert.equal(runtime.resolveMethod(reference('First', 'Choose', [str])).token, 0x06000002);
  assert.equal(runtime.resolveMethod(reference('First', 'Choose', [int], {token: 0x06000003})).token, 0x06000001,
    'A token for a different owner must not hide the exact matching signature.');
  assert.equal(runtime.methodIndex, null, 'Direct and exact lookups do not need a fallback index.');
});

test('linking an assembly invalidates earlier misses and preserves existing candidates', () => {
  const runtime = new ILRuntime({name: 'Initial', types: [type('Existing`1', [method(1, 'Choose', ['!0'])], {genericParameters: ['T']})]});
  const existing = reference(`Existing\`1<${int}>`, 'Choose', [int]);
  const later = reference(`Later\`1<${str}>`, 'Choose', [str]);
  const before = runtime.resolveMethod(existing);
  assert.equal(runtime.resolveMethod(later), null);
  runtime.addAssembly({name: 'Linked', types: [type('Later`1', [method(1, 'Choose', ['!0'])], {genericParameters: ['T']})]});
  assert.equal(runtime.resolveMethod(later).$assembly, 'Linked');
  assert.equal(runtime.resolveMethod(existing), before);
  assert.equal(runtime.resolveMethod(reference('System.IO.BinaryReader', 'ReadByte')), null);
});

test('a partially rejected link cannot leave stale fallback candidates', () => {
  const runtime = new ILRuntime({name: 'Initial', types: [type('Existing', [])]});
  const later = reference(`Later\`1<${int}>`, 'Choose', [int]);
  assert.equal(runtime.resolveMethod(later), null);
  assert.throws(() => runtime.addAssembly({name: 'Rejected', types: [
    type('Later`1', [method(1, 'Choose', ['!0'])], {genericParameters: ['T']}),
    type('Existing', []),
  ]}), /Type collision/);
  // addAssembly already retains metadata linked before the collision. Resolution
  // must reflect that same method table rather than the index from before linking.
  assert.equal(runtime.resolveMethod(later).$assembly, 'Rejected');
});

test('disposing a native module releases its populated method candidate index', async t => {
  let runtime;
  const candidates = ILRuntime.prototype.methodCandidates;
  t.mock.method(ILRuntime.prototype, 'methodCandidates', function(ref) {
    runtime = this;
    return candidates.call(this, ref);
  });
  const write = reference('System.Console', 'WriteLine', [str], {isStatic: true, returnType: 'System.Void'});
  const main = method(1, 'Main', [], {locals: [], body: [
    {offset: 0, opcode: 'ldstr', operand: 'index populated'},
    {offset: 1, opcode: 'call', operand: write},
    {offset: 2, opcode: 'ldc.i4', operand: 42},
    {offset: 3, opcode: 'ret'},
  ]});
  const executable = await loadWasm(compileWasm({name: 'Disposal', types: [type('Program', [main])]}));
  try {
    assert.equal(executable.invoke('Program::Main'), 42);
    assert(runtime?.methodIndex instanceof Map);
    assert(runtime.methods.size > 0);
    executable.dispose();
    assert.equal(runtime.methodIndex, null);
    assert.equal(runtime.methods.size, 0);
    assert.equal(executable.stdout, '');
    assert.throws(() => executable.invoke('Program::Main'), error => error.code === 'DISPOSED');
    executable.dispose();
  } finally { executable.dispose(); }
});
