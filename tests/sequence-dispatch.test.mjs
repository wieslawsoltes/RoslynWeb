import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileAssembly} from '../src/il/compiler.mjs';
import {isExtendedBuiltin} from '../src/il/framework.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=readFileSync(new URL('./sequence-dispatch-fixture.cs',import.meta.url),'utf8');
const model=JSON.parse(readFileSync(new URL('./sequence-dispatch-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(readFileSync(new URL('./sequence-dispatch-baseline.json',import.meta.url),'utf8'));
const nativeCases=baseline.cases;
test('synthetic sequence dispatch keeps exact List enumerator admission',()=>{
  const ref={declaringType:'System.Collections.Generic.List`1+Enumerator<System.Int32>',name:'MoveNext',isStatic:false,genericParameterCount:0,parameters:[],returnType:'System.Boolean'};
  assert.equal(isExtendedBuiltin(ref),true);
  for(const altered of [{returnType:undefined},{returnType:'System.Object'},{isStatic:true},{genericParameterCount:1}])assert.equal(isExtendedBuiltin({...ref,...altered}),false);
  assert.equal(isExtendedBuiltin({...ref,name:'get_Current',returnType:'System.Object'}),false);
});
test('framework sequence dispatch fixture authenticates its real .NET oracle source',()=>{
  assert.equal(baseline.sourceSha256,createHash('sha256').update(source).digest('hex'));
  assert.equal(baseline.runtime,'10.0.0');
});
for(const optimize of [false,'blocks',true])test(`framework sequence dispatch comparisons match .NET, JavaScript optimize=${optimize}`,()=>{
  const program=compileAssembly(model,{strict:true,optimize});
  for(const item of baseline.cases)assert.deepEqual(program.invoke(`SequenceDispatchFixture::${item.method}`),item.result,item.method);
});
for(const optimize of [false,true])test(`framework sequence dispatch comparisons match .NET, native Wasm optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{optimize,exports:nativeCases.map(item=>`SequenceDispatchFixture::${item.method}`)});
  assert.ok(WebAssembly.validate(artifact.bytes));
  const program=await loadWasm(artifact.bytes);
  try{for(const item of nativeCases)assert.deepEqual(program.invoke(`SequenceDispatchFixture::${item.method}`),item.result,item.method);}
  finally{program.dispose();}
});
