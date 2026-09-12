import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {isExtendedBuiltin} from '../src/il/framework.mjs';
const revive=(_key,value)=>value?.$int64?BigInt(value.$int64):value;
const model=JSON.parse(await readFile(new URL('./cad-collections-fixture.json',import.meta.url),'utf8'),revive);
const cases=JSON.parse(await readFile(new URL('./cad-collections-baseline.json',import.meta.url),'utf8'),revive),exports=[...new Set(cases.map(item=>item.method))];
for(const optimize of [false,'blocks',true]){
 const program=compileAssembly(model,{strict:true,optimize,exports});
 for(const item of cases)test(`CAD collection ${item.method}(${item.args}) JavaScript ${optimize}`,()=>assert.deepEqual(program.invoke('CadCollectionsFixture::'+item.method,item.args),item.result));
}
for(const optimize of [false,true])test(`CAD collections generated Wasm ${optimize}`,async()=>{
 const artifact=compileWasm(model,{exports,optimize});const program=await loadWasm(artifact.bytes);
 try{for(const item of cases)assert.deepEqual(program.invoke('CadCollectionsFixture::'+item.method,item.args),item.result,`${item.method}(${item.args})`);}finally{program.dispose();}
});
test('new collection overloads reject unsupported or malformed signatures',()=>{
 const ref=(declaringType,name,parameters,returnType='System.Void',isStatic=false,genericArguments=[])=>({declaringType,name,parameters,returnType,isStatic,genericArguments});
 assert.equal(isExtendedBuiltin(ref('System.Array','Reverse',['!!0[]'],'System.Void',true,['System.Int32'])),true);
 assert.equal(isExtendedBuiltin(ref('System.Array','Reverse',['System.Array','System.Int64','System.Int64'],'System.Void',true)),false);
 assert.equal(isExtendedBuiltin(ref('System.Array','Reverse',['System.Int32[]'],'System.Boolean',true,['System.Int32'])),false);
 assert.equal(isExtendedBuiltin(ref('System.Collections.Hashtable','.ctor',['System.Runtime.Serialization.SerializationInfo','System.Runtime.Serialization.StreamingContext'])),false);
 assert.equal(isExtendedBuiltin(ref('System.Collections.Hashtable','Synchronized',['System.Collections.Hashtable'],'System.Collections.Hashtable',true)),false);
 assert.equal(isExtendedBuiltin(ref('System.Collections.Generic.List`1<System.Int32>','Sort',['System.Func`2<System.Int32,System.Int32>'])),false);
 assert.equal(isExtendedBuiltin(ref('System.Collections.Generic.ICollection`1<System.Int32>','Contains',['System.String'],'System.Boolean')),false);
 assert.equal(isExtendedBuiltin(ref('System.Collections.Generic.ICollection`1<System.Int32>','Contains',['System.Int32'],'System.Int32')),false);
});
