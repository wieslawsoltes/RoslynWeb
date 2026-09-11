import test from 'node:test';
import assert from 'node:assert/strict';
import {ILAssemblyBuilder,analyzeAssembly,compileJavaScriptModule,generateModule} from '../src/il/index.js';

function fixture() {
  const dependency = new ILAssemblyBuilder('Dependency');
  const type = dependency.defineType('Dependency.Calculator');
  const seed = type.defineField('Seed','System.Int32',{isStatic:true});
  type.defineMethod('.cctor').emit('ldc.i4',7).emit('stsfld',seed).emit('ret');
  const twice = type.defineMethod('Twice',{parameters:['System.Int32'],returnType:'System.Int32'});
  twice.emit('ldarg.0').emit('ldc.i4.2').emit('mul').emit('ldsfld',seed).emit('add').emit('ret');
  const unsupported = type.defineMethod('Unrelated',{returnType:'System.Int32'});
  unsupported.emit('call',{declaringType:'Missing.Service',name:'Read',parameters:[],returnType:'System.Int32',isStatic:true}).emit('ret');
  const assembly = new ILAssemblyBuilder('Exports');
  const api = assembly.defineType('Api');
  const entry = api.defineMethod('Calculate',{parameters:['System.Int32'],returnType:'System.Int32'});
  entry.emit('ldarg.0').emit('call',twice).emit('ret');
  assembly.setEntryPoint(entry);
  return {model:assembly.toModel(),dependency:dependency.toModel()};
}

test('strict JavaScript exports retain linked calls and initializers, omit unrelated unsupported methods',()=>{
  const {model,dependency} = fixture(), original = structuredClone([model,dependency]);
  assert.equal(analyzeAssembly(model,{assemblies:[dependency]}).supported,false);
  const options = {assemblies:[dependency],exports:['Api.Calculate'],strict:true};
  const module = compileJavaScriptModule(model,options);
  assert.equal(module.analysis.supported,true);
  assert.deepEqual(module.analysis.selection,{exports:['Api::Calculate(System.Int32)'],retainedMethods:3,totalMethods:4,retainsAll:false});
  assert.equal(module.createRuntime().invoke('Api::Calculate',[5]),17);
  assert.equal(module.linked[0].model.types[0].methods.some(m=>m.name==='Unrelated'),false);
  assert.deepEqual([model,dependency],original,'selection must not mutate cached inspection metadata');
  assert.throws(()=>compileJavaScriptModule(model,{assemblies:[dependency],exports:['Api.Calculate','Unrelated'],strict:true}),error=>error.diagnostics.some(d=>d.code==='IL_EXPORT_SELECTION'));
});

test('selected generated ES modules retain the same closure and invoke without the compiler',async()=>{
  const {model,dependency} = fixture();
  const source = generateModule(model,{assemblies:[dependency],exports:['Calculate'],strict:true,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href});
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(module.createAssembly().invoke('Api::Calculate',[10]),27);
  assert.equal(module.linkedAssemblies[0].model.types[0].methods.length,2);
});

test('invalid and ambiguous JavaScript selectors fail before code generation',()=>{
  const assembly = new ILAssemblyBuilder('Ambiguous'), type = assembly.defineType('Api');
  type.defineMethod('Value',{returnType:'System.Int32'}).emit('ldc.i4.1').emit('ret');
  type.defineMethod('Value',{parameters:['System.Int32'],returnType:'System.Int32'}).emit('ldarg.0').emit('ret');
  const model=assembly.toModel();
  for (const exports of ['Value',['Value'],['Missing']]) assert.throws(()=>compileJavaScriptModule(model,{exports,strict:true}),error=>error.diagnostics.some(d=>d.code==='IL_EXPORT_SELECTION'));
  assert.equal(compileJavaScriptModule(model,{exports:['Api::Value()'],strict:true}).createRuntime().invoke('Api::Value()'),1);
});

test('virtual calls retain concrete implementations and their callees',()=>{
  const assembly = new ILAssemblyBuilder('Virtual');
  const base=assembly.defineType('Base');
  const value=base.defineMethod('Value',{isStatic:false,isAbstract:true,isVirtual:true,returnType:'System.Int32'});
  const derived=assembly.defineType('Derived',{baseType:'Base'});
  const ctor=derived.defineConstructor();ctor.emit('ret');
  const helper=derived.defineMethod('Helper',{returnType:'System.Int32'});helper.emit('ldc.i4',42).emit('ret');
  derived.defineMethod('Value',{isStatic:false,isVirtual:true,returnType:'System.Int32'}).emit('call',helper).emit('ret');
  const api=assembly.defineType('Api');
  api.defineMethod('Read',{returnType:'System.Int32'}).emit('newobj',ctor).emit('callvirt',value).emit('ret');
  const module=compileJavaScriptModule(assembly.toModel(),{exports:['Api.Read'],strict:true});
  assert.equal(module.createRuntime().invoke('Api::Read'),42);
});

test('runtime reflection conservatively retains all inspected methods',()=>{
  const {model,dependency}=fixture();
  const root=model.types[0].methods[0];
  root.parameters=[];root.returnType='System.Object';
  root.body=[{offset:0,opcode:'ldnull'},{offset:1,opcode:'call',operand:{declaringType:'System.Activator',name:'CreateInstance',parameters:['System.Type'],returnType:'System.Object',isStatic:true}},{offset:2,opcode:'ret'}];
  const analysis=analyzeAssembly(model,{assemblies:[dependency],exports:['Calculate']});
  assert.equal(analysis.selection.retainsAll,true);
  assert.equal(analysis.selection.retainedMethods,analysis.selection.totalMethods);
  assert.equal(analysis.supported,false,'unsupported methods potentially reached by reflection stay visible');
});

test('selected genuine C# collection methods preserve generic comparers and delegate callbacks',async()=>{
  const {readFile}=await import('node:fs/promises');
  const model=JSON.parse(await readFile(new URL('./il-collections-fixture.json',import.meta.url)));
  const baseline=JSON.parse(await readFile(new URL('./il-collections-native-baseline.json',import.meta.url)));
  for (const [name,expected] of Object.entries(baseline.results)) {
    const module=compileJavaScriptModule(model,{exports:[`CollectionsFixture::${name}`],strict:true});
    assert.equal(String(module.createRuntime().invoke(`CollectionsFixture::${name}`)),expected,name);
  }
});

test('selected tuple services retain implicit managed equality and comparison overrides',async()=>{
  const {readFile}=await import('node:fs/promises');
  const model=JSON.parse(await readFile(new URL('./value-interfaces-fixture.json',import.meta.url)));
  for (const [name,expected] of [['ManagedEqualsOverride',true],['ManagedCompareOverride',-3]]) {
    const module=compileJavaScriptModule(model,{exports:[name],strict:true});
    assert.equal(module.createRuntime().invoke(`ValueInterfaces::${name}`),expected);
    assert(module.analysis.selection.retainedMethods<model.types.flatMap(t=>t.methods).length);
    assert(module.linked.length===0);
    assert(module.model.types.find(t=>t.name==='HashValue').methods.some(m=>m.name===(name==='ManagedEqualsOverride'?'Equals':'CompareTo')));
  }
});

test('reachable unsupported calls still reject a selected root',()=>{
  const {model,dependency}=fixture();
  const root=model.types[0].methods[0];
  root.body=[{offset:0,opcode:'call',operand:{declaringType:'Dependency.Calculator',name:'Unrelated',assemblyName:'Dependency',isStatic:true,returnType:'System.Int32',parameters:[]}},{offset:1,opcode:'ret'}];
  assert.throws(()=>compileJavaScriptModule(model,{assemblies:[dependency],exports:['Api.Calculate'],strict:true}),error=>error.diagnostics.some(d=>d.code==='IL_UNRESOLVED_CALL'&&d.message.includes('Missing.Service')));
});

test('HashSet enumerable constructors retain implicit equality and hash callbacks',()=>{
  const assembly=new ILAssemblyBuilder('SetConstructor'), value=assembly.defineType('EqualValue');
  const ctor=value.defineConstructor();ctor.emit('ret');
  value.defineMethod('Equals',{isStatic:false,returnType:'System.Boolean',parameters:['System.Object']}).emit('ldc.i4.1').emit('ret');
  value.defineMethod('GetHashCode',{isStatic:false,returnType:'System.Int32'}).emit('ldc.i4.0').emit('ret');
  const api=assembly.defineType('Api'), run=api.defineMethod('Run',{returnType:'System.Int32'});
  run.emit('ldc.i4.2').emit('newarr','EqualValue').emit('dup').emit('ldc.i4.0').emit('newobj',ctor).emit('stelem.ref')
    .emit('dup').emit('ldc.i4.1').emit('newobj',ctor).emit('stelem.ref')
    .emit('newobj',{declaringType:'System.Collections.Generic.HashSet`1<EqualValue>',name:'.ctor',isStatic:false,returnType:'System.Void',parameters:['System.Collections.Generic.IEnumerable`1<EqualValue>']})
    .emit('callvirt',{declaringType:'System.Collections.Generic.HashSet`1<EqualValue>',name:'get_Count',isStatic:false,returnType:'System.Int32',parameters:[]}).emit('ret');
  assert.equal(compileJavaScriptModule(assembly.toModel(),{exports:['Run'],strict:true}).createRuntime().invoke('Api::Run'),1);
});

test('System.Type member discovery preserves methods named at runtime',()=>{
  const assembly=new ILAssemblyBuilder('Discovery'), api=assembly.defineType('Api');
  api.defineMethod('Hidden',{returnType:'System.Int32'}).emit('ldc.i4.7').emit('ret');
  api.defineMethod('Run',{returnType:'System.Boolean'}).emit('ldtoken',{name:'Api',token:api.token})
    .emit('call',{declaringType:'System.Type',name:'GetTypeFromHandle',isStatic:true,returnType:'System.Type',parameters:['System.RuntimeTypeHandle']})
    .emit('ldstr','Hidden').emit('callvirt',{declaringType:'System.Type',name:'GetMethod',isStatic:false,returnType:'System.Reflection.MethodInfo',parameters:['System.String']})
    .emit('ldnull').emit('cgt.un').emit('ret');
  const module=compileJavaScriptModule(assembly.toModel(),{exports:['Run'],strict:true});
  assert.equal(module.analysis.selection.retainsAll,true);
  assert.equal(module.createRuntime().invoke('Api::Run'),true);
});

test('interface MethodImpl mappings retain a differently named implementation',()=>{
  const assembly=new ILAssemblyBuilder('MappedImplementation'), contract=assembly.defineType('IFoo',{attributes:'Public, Interface, Abstract'});
  const declaration=contract.defineMethod('Value',{isStatic:false,isAbstract:true,isVirtual:true,returnType:'System.Int32'});
  const concrete=assembly.defineType('Foo',{interfaces:['IFoo']}), ctor=concrete.defineConstructor();ctor.emit('ret');
  const implementation=concrete.defineMethod('DifferentName',{isStatic:false,isVirtual:true,returnType:'System.Int32'});implementation.emit('ldc.i4',42).emit('ret');
  concrete.options.methodOverrides=[{declaration:declaration.asReference(),body:implementation.asReference()}];
  assembly.defineType('Api').defineMethod('Run',{returnType:'System.Int32'}).emit('newobj',ctor).emit('callvirt',declaration).emit('ret');
  const module=compileJavaScriptModule(assembly.toModel(),{exports:['Run'],strict:true});
  assert.equal(module.createRuntime().invoke('Api::Run'),42);
});

test('generic comparer interfaces retain custom comparison implementations',()=>{
  const assembly=new ILAssemblyBuilder('InterfaceComparer');
  const comparer=assembly.defineType('Descending',{interfaces:['System.Collections.Generic.IComparer`1<System.Int32>']});
  const ctor=comparer.defineConstructor();ctor.emit('ret');
  comparer.defineMethod('Compare',{isStatic:false,parameters:['System.Int32','System.Int32'],returnType:'System.Int32'}).emit('ldarg.2').emit('ldarg.1').emit('sub').emit('ret');
  const set='System.Collections.Generic.SortedSet`1<System.Int32>', run=assembly.defineType('Api').defineMethod('Run',{returnType:'System.Int32'});
  run.emit('newobj',ctor).emit('newobj',{declaringType:set,name:'.ctor',isStatic:false,returnType:'System.Void',parameters:['System.Collections.Generic.IComparer`1<System.Int32>']})
    .emit('dup').emit('ldc.i4.1').emit('callvirt',{declaringType:set,name:'Add',isStatic:false,returnType:'System.Boolean',parameters:['System.Int32']}).emit('pop')
    .emit('dup').emit('ldc.i4.2').emit('callvirt',{declaringType:set,name:'Add',isStatic:false,returnType:'System.Boolean',parameters:['System.Int32']}).emit('pop')
    .emit('callvirt',{declaringType:set,name:'get_Min',isStatic:false,returnType:'System.Int32',parameters:[]}).emit('ret');
  assert.equal(compileJavaScriptModule(assembly.toModel(),{exports:['Run'],strict:true}).createRuntime().invoke('Api::Run'),2);
});
