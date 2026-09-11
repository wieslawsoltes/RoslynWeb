import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeWasmAssembly, wasmType, isNativeWasmBuiltin } from '../src/wasm/analysis.mjs';

const instruction = (offset, opcode, operand) => ({offset,opcode,operand,size:1});
const method = (name,body,other={}) => ({name,declaringType:'Example',isStatic:true,attributes:'Public, Static',returnType:'System.Int32',parameters:[],locals:[],body,token:0x06000001,...other});
const assembly = (methods,other={}) => ({name:'ExampleAssembly',entryPoint:null,types:[{name:'Example',methods,fields:[],baseType:'System.Object'}],...other});
const ref = (name,other={}) => ({name,declaringType:'Example',isStatic:true,returnType:'System.Int32',parameters:[],...other});
const codes = result => result.diagnostics.map(d=>d.code);

test('native Wasm analysis preserves native primitive kinds and rejects unresolved value representations',()=>{
  for(const [clr,kind] of [['System.Int32','i32'],['System.UInt64','i64'],['System.Single','f32'],['System.Double','f64'],['System.String','externref'],['System.Int32&','externref'],['System.Int32[]','externref']])assert.equal(wasmType(clr),kind);
  assert.throws(()=>wasmType('!!0'),/Open generic/);
  assert.throws(()=>wasmType('System.Int32*'),/Pointer/);
  assert.equal(wasmType('System.Nullable`1<System.Int32>'),'externref');
  assert.equal(wasmType('System.Decimal'),'externref');
  assert.equal(wasmType('System.ValueTuple`2<System.Int32,System.Double>'),'externref');
  assert.throws(()=>wasmType('System.Nullable`1<System.Int32*>'),/Pointer/);
  assert.throws(()=>wasmType('ThirdParty.Struct',{valueTypes:new Set(['ThirdParty.Struct'])}),/Value type/);
  assert.equal(wasmType('E',{types:new Map([['E',{isEnum:true,fields:[{name:'value__',type:'System.Int64'}]}]])}),'i64');
});

test('every numeric and array method from actual Roslyn DLL passes typed control flow',()=>{
  const model=JSON.parse(fs.readFileSync(new URL('./wasm-native-fixture.json',import.meta.url),'utf8'));
  const result=analyzeWasmAssembly(model,{exports:['NativeNumeric::Loop','NativeNumeric::Switch','NativeNumeric::Fibonacci','NativeNumeric::ArrayLoop','NativeNumeric::LongAdd','NativeNumeric::DoubleArithmetic']});
  assert.equal(result.supported,true,JSON.stringify(result.diagnostics));
  assert.equal(result.exports.length,6);
  for(const descriptor of result.methods){
    assert.ok(descriptor.blocks.length>0);
    for(const block of descriptor.blocks){
      assert.deepEqual(block.stack,descriptor.stackBefore.get(block.offset));
      for(const i of block.instructions){assert.ok(Array.isArray(i.before));assert.ok(Array.isArray(i.after));}
    }
  }
  const loop=result.methods.find(m=>m.method.name==='Loop');
  assert.ok(loop.blocks.some(b=>b.successors.some(offset=>offset<=b.offset)),'the real loop contains a backward native CFG edge');
});

test('reachable closure ignores unrelated unsupported bodies and supports explicit private roots',()=>{
  const good=method('Good',[instruction(0,'ldc.i4.7'),instruction(1,'ret')]);
  const bad=method('Bad',[instruction(0,'localloc'),instruction(1,'ret')],{attributes:'Private, Static',token:0x06000002});
  assert.equal(analyzeWasmAssembly(assembly([good,bad]),{exports:['Good']}).supported,true);
  assert.ok(codes(analyzeWasmAssembly(assembly([good,bad]),{exports:['Bad']})).includes('WASM_UNSUPPORTED_OPCODE'));
});

test('native CFG rejects unequal stack heights and invalid branch offsets before code generation',()=>{
  const merge=method('Merge',[instruction(0,'ldc.i4.0'),instruction(1,'brtrue',4),instruction(2,'ldc.i4.1'),instruction(3,'br',4),instruction(4,'ldc.i4.2'),instruction(5,'ret')]);
  assert.ok(codes(analyzeWasmAssembly(assembly([merge]))).includes('WASM_STACK_MERGE'));
  const invalid=method('Invalid',[instruction(0,'br',7),instruction(1,'ldc.i4.0'),instruction(2,'ret')]);
  assert.ok(codes(analyzeWasmAssembly(assembly([invalid]))).includes('WASM_INVALID_BRANCH'));
});

test('native CFG rejects bad calls and underflow while widening mixed floating operands',()=>{
  const bad=method('Bad',[instruction(0,'call',ref('Missing')),instruction(1,'ret')]);
  assert.ok(codes(analyzeWasmAssembly(assembly([bad]))).includes('WASM_UNRESOLVED_CALL'));
  assert.ok(codes(analyzeWasmAssembly(assembly([method('Underflow',[instruction(0,'add'),instruction(1,'ret')])]))).includes('WASM_STACK_TYPE'));
  const mixed=method('Mixed',[instruction(0,'ldc.r4',1),instruction(1,'ldc.r8',2),instruction(2,'add'),instruction(3,'ret')],{returnType:'System.Double'});
  const result=analyzeWasmAssembly(assembly([mixed]));assert.equal(result.supported,true,JSON.stringify(result.diagnostics));assert.deepEqual(result.methods[0].instructions[2].coercions,[{slot:0,from:'f32',to:'f64'}]);assert.deepEqual(result.methods[0].instructions[2].after,['f64']);
});

test('closed generic native methods specialize at each call and preserve literal string contents',()=>{
  const generic=method('Identity',[instruction(0,'ldstr','!!0 literal'),instruction(1,'pop'),instruction(2,'ldarg.0'),instruction(3,'ret')],{attributes:'Private, Static',token:0x06000002,genericParameters:['T'],returnType:'!!0',parameters:[{type:'!!0'}]});
  const callType=kind=>ref('Identity',{assemblyName:'ExampleAssembly',genericParameterCount:1,genericArguments:[kind],returnType:'!!0',parameters:[{type:'!!0'}]});
  const root=method('Root',[instruction(0,'ldc.i4.7'),instruction(1,'call',callType('System.Int32')),instruction(2,'pop'),instruction(3,'ldc.i8','42'),instruction(4,'call',callType('System.Int64')),instruction(5,'ret')],{returnType:'System.Int64'});
  const result=analyzeWasmAssembly(assembly([root,generic]),{exports:['Root']});
  assert.equal(result.supported,true,JSON.stringify(result.diagnostics));
  assert.equal(result.methods.length,3);
  assert.deepEqual(result.methods.filter(m=>m.method.name==='Identity').map(m=>m.paramTypes),[['i32'],['i64']]);
  assert.ok(result.methods.filter(m=>m.method.name==='Identity').every(m=>m.instructions[0].operand==='!!0 literal'));
  const exported=analyzeWasmAssembly(assembly([generic]),{exports:[{type:'Example',method:'Identity',parameters:['System.Int64'],genericArguments:['System.Int64']}]});
  assert.equal(exported.supported,true,JSON.stringify(exported.diagnostics)); assert.deepEqual(exported.methods[0].paramTypes,['i64']);
});

test('assembly identity prevents linking a same-named method from the wrong dependency',()=>{
  const targetA=assembly([method('Value',[instruction(0,'ldc.i4.1'),instruction(1,'ret')])],{name:'A'});
  const targetB=assembly([method('Value',[instruction(0,'ldc.i4.2'),instruction(1,'ret')])],{name:'B'});
  const root=assembly([method('Main',[instruction(0,'call',ref('Value',{assemblyName:'B'})),instruction(1,'ret')])]);
  const result=analyzeWasmAssembly(root,{assemblies:[targetA,targetB]});
  assert.equal(result.supported,true,JSON.stringify(result.diagnostics));
  assert.equal(result.methods[1].assemblyName,'B');
  root.references=[{name:'B',version:'1.0.0.0',culture:'',publicKeyToken:'null'}]; targetB.version='2.0.0.0';
  assert.ok(codes(analyzeWasmAssembly(root,{assemblies:[targetA,targetB]})).includes('WASM_ASSEMBLY_IDENTITY'));
  targetB.version='1.0.0.0';assert.equal(analyzeWasmAssembly(root,{assemblies:[targetA,targetB]}).supported,true);
  delete root.types[0].methods[0].body[0].operand.assemblyName;
  assert.ok(codes(analyzeWasmAssembly(root,{assemblies:[targetA,targetB]})).includes('WASM_AMBIGUOUS_CALL'));
  assert.ok(codes(analyzeWasmAssembly(root,{assemblies:[targetA,targetA]})).includes('WASM_ASSEMBLY_IDENTITY'));
});

test('static initializer enters reachable closure and is attached to static field access',()=>{
  const field={name:'Value',declaringType:'Example',assemblyName:'ExampleAssembly',type:'System.Int32',isStatic:true};
  const root=method('Get',[instruction(0,'ldsfld',field),instruction(1,'ret')]);
  const cctor=method('.cctor',[instruction(0,'ldc.i4.7'),instruction(1,'stsfld',field),instruction(2,'ret')],{returnType:'System.Void',attributes:'Private, Static',token:0x06000002});
  const model=assembly([root,cctor]);model.types[0].fields=[field];
  const result=analyzeWasmAssembly(model,{exports:['Get']});
  assert.equal(result.supported,true,JSON.stringify(result.diagnostics));
  assert.equal(result.methods.length,2);assert.equal(result.methods[0].instructions[0].initializer,1);
});

test('primitive byref addresses retain typed locals and address-taken metadata',()=>{
  const model=assembly([method('Byref',[instruction(0,'ldloca.s',0),instruction(1,'ldc.i4.7'),instruction(2,'stind.i4'),instruction(3,'ldloc.0'),instruction(4,'ret')],{locals:['System.Int32']})]);
  const result=analyzeWasmAssembly(model);assert.equal(result.supported,true,JSON.stringify(result.diagnostics));assert.deepEqual([...result.methods[0].addressTakenLocals],[0]);assert.deepEqual(result.methods[0].stackBefore.get(2),['externref','i32']);
});

test('closed user struct fields are checked recursively and explicit layouts fail preflight',()=>{
  const model=assembly([method('Struct',[instruction(0,'ldc.i4.0'),instruction(1,'ret')],{locals:['Pair']})]);
  model.types.push({name:'Pair',isValueType:true,fields:[{name:'X',type:'System.Int32'},{name:'Y',type:'System.Int32'}],methods:[]});
  assert.equal(analyzeWasmAssembly(model).supported,true);
  model.types[1].fields.push({name:'Unsupported',type:'System.Int32*'});
  assert.ok(codes(analyzeWasmAssembly(model)).includes('WASM_UNSUPPORTED_TYPE'));
  model.types[1].fields.pop(); model.types[1].attributes='ExplicitLayout';
  assert.ok(codes(analyzeWasmAssembly(model)).includes('WASM_UNSUPPORTED_TYPE'));
  model.types[1].attributes='SequentialLayout'; model.types[1].isByRefLike=true;
  assert.ok(codes(analyzeWasmAssembly(model)).includes('WASM_UNSUPPORTED_TYPE'));
});

test('native service classifier never accepts dynamic IL generation',()=>{
  assert.equal(isNativeWasmBuiltin(ref('WriteLine',{declaringType:'System.Console',returnType:'System.Void',parameters:[{type:'System.Int32'}]})),true);
  assert.equal(isNativeWasmBuiltin(ref('DefineDynamicAssembly',{declaringType:'System.Reflection.Emit.AssemblyBuilder'})),false);
  assert.equal(isNativeWasmBuiltin(ref('Compile',{declaringType:'System.Linq.Expressions.Expression`1'})),false);
});

test('exception CFG seeds catch reference stack and clears leave stack',()=>{
  const body=[instruction(0,'ldc.i4.0'),instruction(1,'pop'),instruction(2,'leave.s',6),instruction(3,'pop'),instruction(4,'ldc.i4.1'),instruction(5,'leave.s',6),instruction(6,'ldc.i4.7'),instruction(7,'ret')];
  const model=assembly([method('Catch',body,{exceptionHandlers:[{kind:'catch',tryOffset:0,tryLength:3,handlerOffset:3,handlerLength:3,catchType:'System.Exception'}]})]);
  const result=analyzeWasmAssembly(model);assert.equal(result.supported,true,JSON.stringify(result.diagnostics));assert.deepEqual(result.methods[0].stackBefore.get(3),['externref']);assert.deepEqual(result.methods[0].stackBefore.get(6),[]);
});

test('invalid native exception regions and misplaced rethrow fail preflight',()=>{
  const model=assembly([method('Filter',[instruction(0,'ldc.i4.0'),instruction(1,'ret')],{exceptionHandlers:[{kind:'filter',tryOffset:0,tryLength:1,handlerOffset:1,handlerLength:1}]})]);
  assert.ok(codes(analyzeWasmAssembly(model)).includes('WASM_EXCEPTION_REGIONS'));
  const invalid=assembly([method('Rethrow',[instruction(0,'rethrow')])]);assert.ok(codes(analyzeWasmAssembly(invalid)).includes('WASM_EXCEPTION_OPCODE'));
});

test('abstract interface calls collect concrete native implementations without emitting abstract IL',()=>{
  const iface={name:'IValue',attributes:'Public, Interface, Abstract',methods:[method('Get',[],{declaringType:'IValue',isStatic:false,isAbstract:true,attributes:'Public, Virtual, Abstract'})],fields:[]};
  const implementation={name:'Value',baseType:'System.Object',interfaces:['IValue'],methods:[method('Get',[instruction(0,'ldc.i4.7'),instruction(1,'ret')],{declaringType:'Value',isStatic:false,attributes:'Public, Virtual',token:0x06000003})],fields:[]};
  const root=method('Read',[instruction(0,'ldarg.0'),instruction(1,'callvirt',ref('Get',{declaringType:'IValue',isStatic:false,assemblyName:'ExampleAssembly'})),instruction(2,'ret')],{parameters:[{type:'IValue'}]});
  const model=assembly([root]);model.types.push(iface,implementation);
  const result=analyzeWasmAssembly(model,{exports:['Read']});assert.equal(result.supported,true,JSON.stringify(result.diagnostics));assert.equal(result.methods.length,2);assert.equal(result.methods[0].instructions[1].call.kind,'virtual');assert.deepEqual(result.methods[0].instructions[1].call.virtualTargets,[1]);
});


test('floating-point CFG joins converge and promote only outgoing f32 paths',()=>{
  const body=[instruction(0,'ldarg.0'),instruction(1,'brtrue',5),instruction(2,'ldc.r4',1.25),instruction(3,'br',7),instruction(4,'nop'),instruction(5,'ldc.r8',2.5),instruction(6,'br',7),instruction(7,'ldc.r4',4),instruction(8,'add'),instruction(9,'ret')];
  const result=analyzeWasmAssembly(assembly([method('MixedJoin',body,{parameters:[{type:'System.Boolean'}],returnType:'System.Double'})]));
  assert.equal(result.supported,true,JSON.stringify(result.diagnostics));const m=result.methods[0];
  assert.deepEqual(m.stackBefore.get(7),['f64']);assert.deepEqual(m.instructions[3].edgeCoercions,[{slot:0,from:'f32',to:'f64'}]);
  assert.deepEqual(m.instructions[6].edgeCoercions,[]);assert.deepEqual(m.instructions[8].operandTypes,['f64','f64']);
});

test('constrained struct interface calls resolve an unboxed native target',()=>{
  const root=method('Read',[instruction(0,'ldarga.s',0),instruction(1,'constrained.',{name:'Value'}),instruction(2,'callvirt',ref('Get',{declaringType:'IValue',isStatic:false,assemblyName:'ExampleAssembly'})),instruction(3,'ret')],{parameters:[{type:'Value'}]});
  const model=assembly([root]);
  model.types.push({name:'IValue',attributes:'Public, Interface, Abstract',methods:[],fields:[]},{name:'Value',isValueType:true,baseType:'System.ValueType',interfaces:['IValue'],fields:[],methods:[method('Get',[instruction(0,'ldc.i4.7'),instruction(1,'ret')],{declaringType:'Value',isStatic:false,attributes:'Public, Virtual',token:0x06000002})]});
  const result=analyzeWasmAssembly(model);assert.equal(result.supported,true,JSON.stringify(result.diagnostics));
  const call=result.methods[0].instructions[2].call;assert.equal(call.constrainedMode,'direct-value');assert.equal(call.virtual,false);assert.equal(result.methods[call.targetId].method.declaringType,'Value');
});

test('constrained class receivers use dereferencing dispatch and malformed prefixes fail',()=>{
  const root=method('Read',[instruction(0,'ldarga.s',0),instruction(1,'constrained.',{name:'System.String'}),instruction(2,'callvirt',ref('ToString',{declaringType:'System.Object',isStatic:false,returnType:'System.String'})),instruction(3,'ret')],{parameters:[{type:'System.String'}],returnType:'System.String'});
  const result=analyzeWasmAssembly(assembly([root]));assert.equal(result.supported,true,JSON.stringify(result.diagnostics));assert.equal(result.methods[0].instructions[2].call.constrainedMode,'reference');
  root.body[2]=instruction(2,'call',root.body[2].operand);assert.ok(codes(analyzeWasmAssembly(assembly([root]))).includes('WASM_CONSTRAINED_CALL'));
});
