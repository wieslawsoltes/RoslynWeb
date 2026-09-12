// Real C# event accessors, delegates and Interlocked, compared with .NET WASM.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {loadWasm} from '../src/wasm/index.js';
const ok=result=>{assert.equal(result.success,true,JSON.stringify(result.error??result.diagnostics));return result;};
const methods=['Events','Delegates','Equality','Exceptional','Nulls','IntegerAtomics','FloatAtomics','GenericEvents','Snapshot','CollectionEquality','ComparerCollections','NullComparerCollection','ReadOnlyLists','ThreadIdentity'];
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
 const source=await readFile(new URL('./events-fixture.cs',import.meta.url),'utf8');
 const assembly=ok(await compiler.compile(source,{assemblyName:'EventsFixture',outputKind:'library',optimization:'release',emitPdb:false,includeInspection:true}));
 const expected={};for(const method of methods) expected[method]=ok(await compiler.invoke(assembly.assemblyId,'EventFixture',method,[])).result;
 const native=JSON.parse(await readFile(new URL('./events-native-baseline.json',import.meta.url),'utf8'));
 for(const method of methods)assert.deepEqual(expected[method],native.results[method],method+' managed WASM vs native CLR');
 // The bundled Mono interpreter currently fails these multicast sequence cases.
 // Keep that evidence visible and compare generated backends with real CLR output.
 for(const method of ['RemoveAllRepeatedSequences','RemoveRepeatedSequences']) {
  const actual=await compiler.invoke(assembly.assemblyId,'EventFixture',method,[]);
  console.log('Managed multicast sequence probe:',JSON.stringify({method,success:actual.success,result:actual.result,error:actual.error?.type,nativeClr:native.results[method]}));
  expected[method]=native.results[method];methods.push(method);
 }
 console.log('Managed oracle:',JSON.stringify(expected));
 for(const backend of ['javascript','native-wasm'])for(const optimize of [false,true]){
  const options={exports:methods.map(method=>'EventFixture.'+method),strict:true,optimize,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href};
  let artifact,program;
  try{
   artifact=await compiler[backend==='javascript'?'emitJavaScript':'emitWasm'](assembly,options);
   assert.equal(artifact.analysis.diagnostics.length,0);
   program=backend==='javascript'?(await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(artifact.source))).createAssembly():await loadWasm(artifact.bytes);
   for(const method of methods){assert.equal(await program.invoke('EventFixture::'+method,[]),expected[method],`${backend}, optimize=${optimize}: ${method}`);console.log('PASS',backend,optimize,method);}
  }finally{program?.dispose?.();}
 }
 const unsupported=ok(await compiler.compile('public static class UnsupportedThread { public static void Run(){System.Threading.Thread.Sleep(1);} }',{assemblyName:'UnsupportedThread',outputKind:'library',emitPdb:false}));
 for(const method of ['emitJavaScript','emitWasm'])await assert.rejects(compiler[method](unsupported,{exports:['UnsupportedThread.Run'],strict:true}),error=>/Thread|Sleep/.test(JSON.stringify(error.diagnostics??error.details??error)));
 console.log('PASS unsupported thread blocking fails strict emission');
}catch(error){console.error(error.message,JSON.stringify(error.diagnostics??error.details??{}));process.exitCode=1;}finally{await compiler.close();}
