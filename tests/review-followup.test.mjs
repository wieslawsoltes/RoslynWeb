import test from 'node:test';
import assert from 'node:assert/strict';
import { ILAssemblyBuilder, compileJavaScriptModule } from '../src/il/index.js';
import { compileWasm, loadWasm } from '../src/wasm/index.js';

// An interface may be implemented by a member inherited from a base class that
// does not itself declare that interface. Export selection must retain that
// member even though its declaring type is not assignable to the interface.
for (const linked of [false, true]) for (const isVirtual of [false, true]) {
  test(`selected compilers retain inherited ${isVirtual ? 'virtual' : 'nonvirtual'} interface implementation in ${linked ? 'linked' : 'local'} assembly`, async () => {
    const assembly = new ILAssemblyBuilder('InterfaceEntry');
    const dependency = linked ? new ILAssemblyBuilder('InterfaceDependency') : assembly;
    const contract = dependency.defineType('IFoo', { attributes: 'Public, Interface, Abstract' });
    const declaration = contract.defineMethod('Value', { isStatic: false, isAbstract: true, isVirtual: true, returnType: 'System.Int32' });
    const base = dependency.defineType('Base');
    const baseCtor = base.defineConstructor(); baseCtor.emit('ret');
    base.defineMethod('Value', { isStatic: false, isVirtual, returnType: 'System.Int32' }).emit('ldc.i4', 42).emit('ret');
    const derived = dependency.defineType('Derived', { baseType: 'Base', interfaces: ['IFoo'] });
    const ctor = derived.defineConstructor(); ctor.emit('ldarg.0').emit('call', baseCtor).emit('ret');
    assembly.defineType('Api').defineMethod('Run', { returnType: 'System.Int32' }).emit('newobj', ctor).emit('callvirt', declaration).emit('ret');
    const model = assembly.toModel(), assemblies = linked ? [dependency.toModel()] : [];
    const complete = compileJavaScriptModule(model, { strict: true, assemblies });
    assert.equal(complete.createRuntime().invoke('Api::Run'), 42);
    for (const optimize of [false, 'blocks', true]) {
      const selected = compileJavaScriptModule(model, { strict: true, assemblies, exports: ['Api.Run'], optimize });
      assert.equal(selected.createRuntime().invoke('Api::Run'), 42);
      const selectedDependency = linked ? selected.linked[0].model : selected.model;
      assert.ok(selectedDependency.types.find(type => type.name === 'Base').methods.some(method => method.name === 'Value'));
    }
    for (const optimize of [false, true]) {
      const artifact = compileWasm(model, { assemblies, exports: ['Api.Run'], optimize });
      const program = await loadWasm(artifact.bytes);
      try { assert.equal(program.invoke('Api::Run'), 42); }
      finally { program.dispose(); }
    }
  });
}

for (const nullFirst of [false, true]) {
  test(`custom HashSet comparers treat null and a zero-hash equal value as one key, null ${nullFirst ? 'first' : 'last'}`, () => {
    const assembly = new ILAssemblyBuilder('NullComparer');
    const comparerType = 'System.Collections.Generic.IEqualityComparer`1<System.String>';
    const comparer = assembly.defineType('AlwaysEqual', { interfaces: [comparerType] });
    const ctor = comparer.defineConstructor(); ctor.emit('ret');
    comparer.defineMethod('Equals', { isStatic: false, returnType: 'System.Boolean', parameters: ['System.String', 'System.String'] }).emit('ldc.i4.1').emit('ret');
    comparer.defineMethod('GetHashCode', { isStatic: false, returnType: 'System.Int32', parameters: ['System.String'] }).emit('ldc.i4.0').emit('ret');
    const setType = 'System.Collections.Generic.HashSet`1<System.String>';
    const add = { declaringType: setType, name: 'Add', isStatic: false, returnType: 'System.Boolean', parameters: ['System.String'] };
    const run = assembly.defineType('Api').defineMethod('Run', { returnType: 'System.Int32' });
    run.emit('newobj', ctor).emit('newobj', { declaringType: setType, name: '.ctor', isStatic: false, returnType: 'System.Void', parameters: [comparerType] });
    for (const value of nullFirst ? [null, 'x'] : ['x', null]) {
      run.emit('dup');
      if (value === null) run.emit('ldnull'); else run.emit('ldstr', value);
      run.emit('callvirt', add).emit('pop');
    }
    run.emit('callvirt', { declaringType: setType, name: 'get_Count', isStatic: false, returnType: 'System.Int32', parameters: [] }).emit('ret');
    for (const optimize of [false, 'blocks', true]) {
      const program = compileJavaScriptModule(assembly.toModel(), { strict: true, optimize, exports: ['Api.Run'] });
      assert.equal(program.createRuntime().invoke('Api::Run'), 1);
    }
  });
}

for (const equalityComparer of [false, true]) {
  test(`selected JavaScript retains inherited implicit ${equalityComparer ? 'equality' : 'ordering'} comparer callbacks`, () => {
    const assembly = new ILAssemblyBuilder('InheritedComparer');
    const elementType = equalityComparer ? 'System.String' : 'System.Int32';
    const interfaceType = `System.Collections.Generic.${equalityComparer ? 'IEqualityComparer' : 'IComparer'}\`1<${elementType}>`;
    const base = assembly.defineType('ComparerBase');
    const baseCtor = base.defineConstructor(); baseCtor.emit('ret');
    if (equalityComparer) {
      base.defineMethod('Equals', { isStatic: false, returnType: 'System.Boolean', parameters: [elementType, elementType] }).emit('ldc.i4.1').emit('ret');
      base.defineMethod('GetHashCode', { isStatic: false, returnType: 'System.Int32', parameters: [elementType] }).emit('ldc.i4.0').emit('ret');
    } else {
      base.defineMethod('Compare', { isStatic: false, returnType: 'System.Int32', parameters: [elementType, elementType] }).emit('ldarg.2').emit('ldarg.1').emit('sub').emit('ret');
    }
    const comparer = assembly.defineType('Comparer', { baseType: 'ComparerBase', interfaces: [interfaceType] });
    const ctor = comparer.defineConstructor(); ctor.emit('ldarg.0').emit('call', baseCtor).emit('ret');
    const setType = `System.Collections.Generic.${equalityComparer ? 'HashSet' : 'SortedSet'}\`1<${elementType}>`;
    const run = assembly.defineType('Api').defineMethod('Run', { returnType: 'System.Int32' });
    run.emit('newobj', ctor).emit('newobj', { declaringType: setType, name: '.ctor', isStatic: false, returnType: 'System.Void', parameters: [interfaceType] });
    for (const value of equalityComparer ? ['a', 'b'] : [1, 2]) {
      run.emit('dup').emit(equalityComparer ? 'ldstr' : 'ldc.i4', value);
      run.emit('callvirt', { declaringType: setType, name: 'Add', isStatic: false, returnType: 'System.Boolean', parameters: [elementType] }).emit('pop');
    }
    run.emit('callvirt', { declaringType: setType, name: equalityComparer ? 'get_Count' : 'get_Min', isStatic: false, returnType: 'System.Int32', parameters: [] }).emit('ret');
    const expected = equalityComparer ? 1 : 2;
    assert.equal(compileJavaScriptModule(assembly.toModel(), { strict: true }).createRuntime().invoke('Api::Run'), expected);
    for (const optimize of [false, 'blocks', true]) {
      const program = compileJavaScriptModule(assembly.toModel(), { strict: true, optimize, exports: ['Api.Run'] });
      assert.equal(program.createRuntime().invoke('Api::Run'), expected);
    }
  });
}

test('selected JavaScript retains comparer callbacks inherited from a closed generic base', () => {
  const assembly = new ILAssemblyBuilder('GenericInheritedComparer');
  const base = assembly.defineType('GenericComparerBase`1', { genericParameters: ['T'] });
  const baseCtor = base.defineConstructor(); baseCtor.emit('ret');
  base.defineMethod('Equals', { isStatic: false, returnType: 'System.Boolean', parameters: ['!0', '!0'] }).emit('ldc.i4.1').emit('ret');
  base.defineMethod('GetHashCode', { isStatic: false, returnType: 'System.Int32', parameters: ['!0'] }).emit('ldc.i4.0').emit('ret');
  const closedBase = 'GenericComparerBase`1<System.String>';
  const interfaceType = 'System.Collections.Generic.IEqualityComparer`1<System.String>';
  const derived = assembly.defineType('Comparer', { baseType: closedBase, interfaces: [interfaceType] });
  const ctor = derived.defineConstructor(); ctor.emit('ldarg.0').emit('call', { ...baseCtor.asReference(), declaringType: closedBase }).emit('ret');
  const setType = 'System.Collections.Generic.HashSet`1<System.String>';
  const run = assembly.defineType('Api').defineMethod('Run', { returnType: 'System.Int32' });
  run.emit('newobj', ctor).emit('newobj', { declaringType: setType, name: '.ctor', isStatic: false, returnType: 'System.Void', parameters: [interfaceType] });
  for (const value of ['a', 'b']) run.emit('dup').emit('ldstr', value).emit('callvirt', { declaringType: setType, name: 'Add', isStatic: false, returnType: 'System.Boolean', parameters: ['System.String'] }).emit('pop');
  run.emit('callvirt', { declaringType: setType, name: 'get_Count', isStatic: false, returnType: 'System.Int32', parameters: [] }).emit('ret');
  assert.equal(compileJavaScriptModule(assembly.toModel(), { strict: true }).createRuntime().invoke('Api::Run'), 1);
  for (const optimize of [false, 'blocks', true]) {
    const program = compileJavaScriptModule(assembly.toModel(), { strict: true, optimize, exports: ['Api.Run'] });
    assert.equal(program.createRuntime().invoke('Api::Run'), 1);
  }
});
