import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./cad-strings-fixture.cs',import.meta.url),'utf8');
const methods=['Splits','Whitespace','Builders','StringValues','Collation','Enumerators','Errors','EnvironmentValues'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const c=await createRoslyn({startupTimeoutMs:90000,timeoutMs:300000});
try{
 const a=succeed(await c.compile(source,{assemblyName:'CadStringsFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false})),model=a.inspection??await c.inspect(a),cases=[];
 for(const method of methods)cases.push({method,result:succeed(await c.invoke(a.assemblyId,'CadStringsFixture',method)).result});
 const report={runtime:c.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
 const json=v=>JSON.stringify(v,(_,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
 if(process.argv.includes('--update')){await writeFile(new URL('./cad-strings-fixture.json',import.meta.url),json(model));await writeFile(new URL('./cad-strings-baseline.json',import.meta.url),json(report));}
 if(!process.argv.includes('--oracle-only')){
  for(const optimize of [false,'blocks',true]){const program=compileAssembly(model,{strict:true,optimize});for(const item of cases){assert.deepEqual(program.invoke(`CadStringsFixture::${item.method}`),item.result,`${item.method} JS ${optimize}`);console.log(`PASS ${item.method} JS ${optimize}`);}}
  for(const optimize of [false,true]){const artifact=compileWasm(model,{exports:methods,optimize}),program=await loadWasm(artifact.bytes);try{for(const item of cases){assert.deepEqual(program.invoke(`CadStringsFixture::${item.method}`),item.result,`${item.method} Wasm ${optimize}`);console.log(`PASS ${item.method} Wasm ${optimize}`);}}finally{program.dispose();}}
 }
 console.log(`PASS ${cases.reduce((sum,item)=>sum+item.result.length,0)} string/comparer oracle results in five generated modes.`);
}finally{await c.close();}
