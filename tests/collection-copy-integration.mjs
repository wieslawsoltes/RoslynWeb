import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./collection-copy-fixture.cs',import.meta.url),'utf8');
const methods=['ArrayClone','ExplicitClone','ArrayCopy','ListCopy','DictionaryCopy','ListEnumerator','EnumeratorMutation','DefaultValues','BoxedEnumerator','DictionaryEnumerator','KeyEnumerator','TupleReference'];
const cases=[...methods.map(method=>({method,args:[]})),...Array.from({length:14},(_,i)=>({method:'CopyError',args:[i]}))];
const success=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:120000});
try {
  const assembly=success(await compiler.compile(source,{assemblyName:'CollectionCopyFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly);
  for(const item of cases)item.result=success(await compiler.invoke(assembly.assemblyId,'CollectionCopyFixture',item.method,item.args)).result;
  const json=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?{$int64:String(v)}:v,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./collection-copy-fixture.json',import.meta.url),json(model));await writeFile(new URL('./collection-copy-baseline.json',import.meta.url),json(cases));}
  for(const optimize of [false,'blocks',true]) {
    const program=compileAssembly(model,{strict:true,optimize});
    for(const item of cases){assert.deepEqual(program.invoke('CollectionCopyFixture::'+item.method,item.args),item.result,JSON.stringify({method:item.method,args:item.args,optimize}));}
    console.log('PASS collection copies and cloning JavaScript',optimize,cases.length);
  }
  for(const optimize of [false,true]) {
    const artifact=compileWasm(model,{exports:[...methods,'CopyError'],optimize});const program=await loadWasm(artifact.bytes);
    try{for(const item of cases)assert.deepEqual(program.invoke('CollectionCopyFixture::'+item.method,item.args),item.result,JSON.stringify({method:item.method,args:item.args,nativeWasm:true,optimize}));}
    finally{program.dispose();}
    console.log('PASS collection copies and cloning native Wasm',optimize,cases.length);
  }
} finally {await compiler.close();}
