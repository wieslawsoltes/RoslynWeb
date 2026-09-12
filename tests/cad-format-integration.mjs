// Real Roslyn C# -> PE inspection -> JavaScript differential verification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./cad-format-fixture.cs',import.meta.url),'utf8');
const methods=['Doubles','Singles','Integers','Custom','Provider','Errors'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
  const assembly=succeed(await compiler.compile(source,{assemblyName:'CadFormatFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(assembly.assemblyId,'CadFormatFixture',method)).result});
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  const json=v=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./cad-format-fixture.json',import.meta.url),json(model));await writeFile(new URL('./cad-format-baseline.json',import.meta.url),json(report));}
  if(!process.argv.includes('--oracle-only'))for(const optimize of [false,'blocks',true]) {
    const program=compileAssembly(model,{strict:true,optimize});
    for(const item of cases){const actual=program.invoke(`CadFormatFixture::${item.method}`);assert.equal(actual.length,item.result.length);for(let i=0;i<actual.length;i++)assert.equal(actual[i],item.result[i],`${item.method}[${i}], optimize=${optimize}`);console.log(`PASS ${item.method} optimize=${optimize}`);}
  }
  if(!process.argv.includes('--oracle-only'))for(const optimize of [false,true]) {
    const artifact=compileWasm(model,{optimize,exports:methods.map(method=>`CadFormatFixture::${method}`)});
    assert.ok(WebAssembly.validate(artifact.bytes));
    const program=await loadWasm(artifact.bytes);
    try {for(const item of cases){const actual=program.invoke(`CadFormatFixture::${item.method}`);assert.equal(actual.length,item.result.length);for(let i=0;i<actual.length;i++)assert.equal(actual[i],item.result[i],`${item.method}[${i}], native Wasm optimize=${optimize}`);console.log(`PASS ${item.method} native Wasm optimize=${optimize}`);}}
    finally {program.dispose();}
  }
  console.log(`PASS ${cases.reduce((n,c)=>n+c.result.length,0)} numeric formatting oracle cases on .NET ${report.runtime}.`);
} finally {await compiler.close();}
