import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {isCadCultureBuiltin,invokeCadCultureBuiltin,compositeCadFormat} from '../src/il/cad-culture.mjs';
import {createRuntime,i4,r8} from '../src/il/runtime.mjs';
import {createCadNumberFormat} from '../src/il/cad-format.mjs';
const source=readFileSync(new URL('./cad-culture-fixture.cs',import.meta.url),'utf8');
const model=JSON.parse(readFileSync(new URL('./cad-culture-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(readFileSync(new URL('./cad-culture-baseline.json',import.meta.url),'utf8'));
test('culture, composite, rounding, and Enum whitespace fixture matches its .NET oracle source',()=>assert.equal(baseline.sourceSha256,createHash('sha256').update(source).digest('hex')));
for(const optimize of [false,'blocks',true])test(`culture/composite/rounding match .NET ${baseline.runtime}, JavaScript optimize=${optimize}`,()=>{
  let captured='';const program=compileAssembly(model,{strict:true,optimize,output:(text,meta)=>{captured+=text+(meta?.newline?'\n':'');}});
  for(const item of baseline.cases)assert.deepEqual(program.invoke(`CadCultureFixture::${item.method}`),item.result,item.method);
  program.invoke('CadCultureFixture::PrintCurrentNumbers');assert.equal(captured,baseline.consoleStdout);
});
for(const optimize of [false,true])test(`culture/composite/rounding match .NET ${baseline.runtime}, native Wasm optimize=${optimize}`,async()=>{
  let captured='';const artifact=compileWasm(model,{optimize,exports:[...baseline.cases.map(item=>`CadCultureFixture::${item.method}`),'CadCultureFixture::PrintCurrentNumbers']}),program=await loadWasm(artifact.bytes,{output:(text,meta)=>{captured+=text+(meta?.newline?'\n':'');}});
  try{for(const item of baseline.cases)assert.deepEqual(program.invoke(`CadCultureFixture::${item.method}`),item.result,item.method);program.invoke('CadCultureFixture::PrintCurrentNumbers');assert.equal(captured,baseline.consoleStdout);}finally{program.dispose();}
});
const cultureRef={declaringType:'System.Globalization.CultureInfo',name:'get_CurrentCulture',isStatic:true,returnType:'System.Globalization.CultureInfo',parameters:[]};
test('culture admission validates exact signature and rejects unimplemented culture data',()=>{
  assert.equal(isCadCultureBuiltin(cultureRef),true);
  for(const changed of [{isStatic:false},{returnType:'System.Object'},{parameters:['System.String']},{genericArguments:['System.String']}])assert.equal(isCadCultureBuiltin({...cultureRef,...changed}),false);
  const ctor={...cultureRef,name:'.ctor',isStatic:false,returnType:'System.Void',parameters:['System.String']};
  assert.throws(()=>invokeCadCultureBuiltin({},ctor,['fr-FR'],{}),error=>error.runtimeLimitation===true);
});
test('invariant current culture is stable and mutable clones are local to the runtime',()=>{
  const first={},second={},get=rt=>invokeCadCultureBuiltin(rt,cultureRef,[],null).value;
  assert.equal(get(first),get(first));assert.notEqual(get(first),get(second));assert.equal(get(first).name,'');
});
test('composite syntax failures never silently return unparsed format text',()=>{
  const rt=createRuntime(model);
  for(const format of ['{','}','{0','{0:0{0}}','{0,+2}','{0,}','{1}','{ 0}','{0\t}'])assert.throws(()=>compositeCadFormat(rt,format,[i4(1)]),error=>error.$type==='System.FormatException');
  assert.equal(compositeCadFormat(rt,'{{{0:D3}}}',[i4(1)]),'{001}');
});
test('Console composite overloads distinguish array objects from params arrays and reject null params',()=>{
  const output=[],rt=createRuntime(model,{output:value=>output.push(value)}),array={$array:true,$type:'System.Object[]',elementType:'System.Object',items:[i4(1),i4(2)]};
  const method=type=>({declaringType:'System.Console',name:'WriteLine',isStatic:true,returnType:'System.Void',parameters:['System.String',type]});
  rt.callBuiltin(method('System.Object'),['{0}',array],null);
  rt.callBuiltin(method('System.Object[]'),['{0}|{1}',array],null);
  assert.deepEqual(output,['System.Object[]','1|2']);
  assert.throws(()=>rt.callBuiltin(method('System.Object[]'),['literal',null],null),error=>error.$type==='System.ArgumentNullException');
});

test('typed Console numeric values use the current invariant culture clone',()=>{
  const output=[],rt=createRuntime(model,{output:value=>output.push(value)});
  rt.$cadCurrentCulture={numberFormat:{...createCadNumberFormat(),decimalSeparator:'::'}};
  const method={declaringType:'System.Console',name:'WriteLine',isStatic:true,returnType:'System.Void',parameters:[{type:'System.Double'}]};
  rt.callBuiltin(method,[r8(12.5)],null);rt.callBuiltin(method,[r8(1e17)],null);
  assert.deepEqual(output,['12::5','1E+17']);
});
