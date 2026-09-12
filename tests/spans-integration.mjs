import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const source=await readFile(new URL('./spans-fixture.cs',import.meta.url),'utf8');
const methods=['InlineIntegers','InlineObjects','ArrayAlias','Overlap','OverlapLeft','ReferenceAlias','LocalReference','StringSpan','Empty','Equality','Errors','StructCopy','NonCharacterText','ReassignedInline','EmptyIdentity','CovariantArray','FieldIdentity','FormatFour'];
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
 const a=succeed(await compiler.compile(source,{assemblyName:'SpansFixture',outputKind:'library',optimization:'release',emitPdb:false,includeInspection:true}));
 const model=a.inspection??await compiler.inspect(a);
 const cases=[];for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(a.assemblyId,'SpansFixture',method)).result});
 if(process.argv.includes('--update')){await writeFile(new URL('./spans-fixture.json',import.meta.url),JSON.stringify(model,(_,v)=>typeof v==='bigint'?{$int64:String(v)}:v,2)+'\n');await writeFile(new URL('./spans-baseline.json',import.meta.url),JSON.stringify({runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases},null,2)+'\n');}
 for(const optimize of [false,'blocks',true])for(const item of cases){const p=compileAssembly(model,{exports:['SpansFixture.'+item.method],strict:true,optimize});assert.deepEqual(p.invoke('SpansFixture::'+item.method),item.result,item.method+' JS '+optimize);console.log('PASS JS',optimize,item.method);}
 for(const optimize of [false,true])for(const item of cases){const artifact=compileWasm(model,{exports:['SpansFixture.'+item.method],optimize});const p=await loadWasm(artifact.bytes);try{assert.deepEqual(p.invoke('SpansFixture::'+item.method),item.result,item.method+' WASM '+optimize);console.log('PASS WASM',optimize,item.method);}finally{p.dispose();}}
 console.log('PASS '+cases.length+' managed spans scenarios across five compiler modes.');
}finally{await compiler.close();}
