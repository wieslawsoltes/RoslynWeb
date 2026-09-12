import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./custom-attributes-materialization-fixture.cs',import.meta.url),'utf8');
const methods=[...['Generic','Boxed','Array','TypeArg','LongArg'].map(method=>({type:'Probe',method})),{type:'GenericNamedProbe',method:'Named'}];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
  const assembly=succeed(await compiler.compile(source,{assemblyName:'AttributeMaterialization',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const {type,method} of methods)cases.push({type,method,result:succeed(await compiler.invoke(assembly.assemblyId,type,method)).result});
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  const json=v=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./custom-attributes-materialization-fixture.json',import.meta.url),json(model));await writeFile(new URL('./custom-attributes-materialization-baseline.json',import.meta.url),json(report));}
  const exports=methods.map(c=>`${c.type}::${c.method}`);
  for(const optimize of [false,'blocks',true]) {
    const program=compileAssembly(model,{strict:true,optimize,exports});
    for(const c of cases)assert.equal(program.invoke(`${c.type}::${c.method}`),c.result,`${c.method}, optimize=${optimize}`);
  }
  for(const optimize of [false,true]) {
    const artifact=compileWasm(model,{exports,optimize});
    const program=await loadWasm(artifact.bytes);
    try {for(const c of cases)assert.equal(program.invoke(`${c.type}::${c.method}`),c.result,`${c.method}, native-Wasm optimize=${optimize}`);}
    finally {program.dispose();}
  }
  console.log(`PASS ${methods.length} custom attribute materialization scenarios in five generated modes match .NET ${report.runtime}.`);
} finally {await compiler.close();}
