import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./file-exceptions-fixture.cs',import.meta.url),'utf8');
const native=JSON.parse(await readFile(new URL('./file-exceptions-native-baseline.json',import.meta.url),'utf8'));
const methods=['ExplicitMetadata','DefaultMessages','ToStrings','CatchHierarchy','CustomFields','Characters'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const c=await createRoslyn({startupTimeoutMs:90000});
try{
 const assembly=succeed(await c.compile(source,{assemblyName:'FileExceptionsFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
 const model=assembly.inspection??await c.inspect(assembly),managed={};for(const method of methods)managed[method]=succeed(await c.invoke(assembly.assemblyId,'FileExceptionsFixture',method)).result;
 for(const method of ['ExplicitMetadata','CatchHierarchy','CustomFields','Characters'])assert.deepEqual(managed[method],native.results[method],method+' managed/native oracle');
 // Bundled Mono WASM enables UseSystemResourceKeys and has an empty filename
 // loading-message formatter. Preserve its unmodified output beside the native
 // English oracle; generated code follows the complete native .NET behavior.
 const report={nativeRuntime:native.runtime,managedRuntime:c.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),managed,expected:native.results,managedDifferences:methods.filter(method=>JSON.stringify(managed[method])!==JSON.stringify(native.results[method]))};
 if(process.argv.includes('--update')){await writeFile(new URL('./file-exceptions-fixture.json',import.meta.url),JSON.stringify(model,null,2)+'\n');await writeFile(new URL('./file-exceptions-baseline.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
 for(const optimize of [false,'blocks',true]){const program=compileAssembly(model,{strict:true,optimize});for(const method of methods){assert.deepEqual(program.invoke('FileExceptionsFixture::'+method),native.results[method],method+' JS '+optimize);console.log(`PASS ${method} JS ${optimize}`);}}
 for(const optimize of [false,true]){const artifact=compileWasm(model,{exports:methods,optimize});const program=await loadWasm(artifact.bytes);try{for(const method of methods){assert.deepEqual(program.invoke('FileExceptionsFixture::'+method),native.results[method],method+' native-Wasm '+optimize);console.log(`PASS ${method} native-Wasm ${optimize}`);}}finally{program.dispose();}}
 console.log(`PASS ${methods.length} file exception/character scenarios in five generated modes; preserved Mono WASM message differences: ${report.managedDifferences.join(', ')}.`);
}finally{await c.close();}
