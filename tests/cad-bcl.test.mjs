import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {createRuntime,i4} from '../src/il/runtime.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {isCadBuiltin,invokeCadBuiltin} from '../src/il/cad-bcl.mjs';
const model=JSON.parse(await readFile(new URL('./cad-bcl-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./cad-bcl-baseline.json',import.meta.url)));
test('CAD framework oracle authenticates the real compiled C# source',async()=> {
  assert.equal(createHash('sha256').update(await readFile(new URL('./cad-bcl-fixture.cs',import.meta.url))).digest('hex'),baseline.sourceSha256);
  assert.equal(baseline.runtime,'10.0.0');
});
for(const optimize of [false,'blocks',true])test(`CAD framework C# oracle matches JavaScript optimize=${optimize}`,()=> {
  const rt=compileAssembly(model,{strict:true,optimize});
  for(const item of baseline.cases)assert.deepEqual(rt.invoke(`CadBclFixture::${item.method}`),item.result,item.method);
});
for(const optimize of [false,true])test(`CAD framework C# oracle matches native-Wasm optimize=${optimize}`,async()=> {
  const artifact=compileWasm(model,{exports:baseline.cases.map(item=>item.method),optimize});
  const rt=await loadWasm(artifact.bytes);
  try {for(const item of baseline.cases)assert.deepEqual(rt.invoke(`CadBclFixture::${item.method}`),item.result,item.method);}
  finally {rt.dispose();}
});
test('CAD adapters reject unimplemented overload shapes and preserve culture limitations',()=> {
  const ref={declaringType:'System.String',name:'Equals',isStatic:true,returnType:'System.Boolean',parameters:['System.String','System.String','System.StringComparison']};
  assert.equal(isCadBuiltin(ref),true);
  for(const wrong of [{isStatic:false},{returnType:'System.Int32'},{genericArguments:['System.String']},{genericParameterCount:1},{parameters:['System.String','System.String','System.Boolean']}])assert.equal(isCadBuiltin({...ref,...wrong}),false);
  const rt=createRuntime({name:'CadBoundaries',types:[]});
  for(const mode of [0,1,2,3])assert.throws(()=>invokeCadBuiltin(rt,ref,['a','A',i4(mode)],null),e=>e.runtimeLimitation===true);
  assert.equal(invokeCadBuiltin(rt,ref,['é','É',i4(5)],null).value.value,1);
  assert.throws(()=>invokeCadBuiltin(rt,ref,['a','A',i4(99)],null),e=>e.$type==='System.ArgumentException');
  assert.equal(invokeCadBuiltin(rt,ref,['é','É',i4(4)],null).value.value,0);
});
