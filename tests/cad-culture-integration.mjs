// Real Roslyn C# -> PE inspection -> JavaScript differential verification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./cad-culture-fixture.cs',import.meta.url),'utf8');
const methods=['Culture','Composite','Strings','Rounding','Errors','EnumWhitespace'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
  const assembly=succeed(await compiler.compile(source,{assemblyName:'CadCultureFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(assembly.assemblyId,'CadCultureFixture',method)).result});
  const consoleStdout=succeed(await compiler.invoke(assembly.assemblyId,'CadCultureFixture','PrintCurrentNumbers')).stdout;
  const report={consoleStdout,runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  const json=v=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./cad-culture-fixture.json',import.meta.url),json(model));await writeFile(new URL('./cad-culture-baseline.json',import.meta.url),json(report));}
  if(!process.argv.includes('--oracle-only'))for(const optimize of [false,'blocks',true]) {
    let captured='';const output=(text,meta)=>{captured+=text+(meta?.newline?'\n':'');};
    const program=compileAssembly(model,{strict:true,optimize,output});
    for(const item of cases){const actual=program.invoke(`CadCultureFixture::${item.method}`);assert.equal(actual.length,item.result.length);for(let i=0;i<actual.length;i++)assert.equal(actual[i],item.result[i],`${item.method}[${i}], optimize=${optimize}`);console.log(`PASS ${item.method} optimize=${optimize}`);}
    program.invoke('CadCultureFixture::PrintCurrentNumbers');assert.equal(captured,consoleStdout,`Console current culture, optimize=${optimize}`);
  }
  if(!process.argv.includes('--oracle-only'))for(const optimize of [false,true]) {
    const artifact=compileWasm(model,{optimize,exports:[...methods,'PrintCurrentNumbers'].map(method=>`CadCultureFixture::${method}`)});
    assert.ok(WebAssembly.validate(artifact.bytes));
    let captured='';const program=await loadWasm(artifact.bytes,{output:(text,meta)=>{captured+=text+(meta?.newline?'\n':'');}});
    try {for(const item of cases){const actual=program.invoke(`CadCultureFixture::${item.method}`);assert.equal(actual.length,item.result.length);for(let i=0;i<actual.length;i++)assert.equal(actual[i],item.result[i],`${item.method}[${i}], native Wasm optimize=${optimize}`);console.log(`PASS ${item.method} native Wasm optimize=${optimize}`);}
      program.invoke('CadCultureFixture::PrintCurrentNumbers');assert.equal(captured,consoleStdout,`Console current culture, native Wasm optimize=${optimize}`);}
    finally {program.dispose();}
  }
  console.log(`PASS ${cases.reduce((n,c)=>n+c.result.length,0)} culture/composite/rounding oracle cases on .NET ${report.runtime}.`);
} finally {await compiler.close();}
