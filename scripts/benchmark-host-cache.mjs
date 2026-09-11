import assert from 'node:assert/strict';
import {writeFile, readFile, mkdir, mkdtemp, cp, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {JavaScriptCompilerHost as CurrentJS} from '../src/javascript-host.mjs';
import {NativeWasmHost as CurrentWasm} from '../src/wasm/host.mjs';
import {createRoslyn} from '../src/browser.js';

// Baseline source can come from a normal git checkout or an extracted archive.
// Only the host/cache files differ: both versions use identical current engines.
const argument = name => { const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1]; };
const root=fileURLToPath(new URL('../',import.meta.url));
const baselineRoot=argument('--baseline-root');
const baselineRef=argument('--baseline') || '5f664631159c673ca3e5bf7a99e7866fa04040b2';
await mkdir(join(root,'artifacts'),{recursive:true});
const baselineDirectory=await mkdtemp(join(root,'artifacts','host-cache-baseline-'));
await cp(join(root,'src'),join(baselineDirectory,'src'),{recursive:true});
const baselineFiles={};
for(const path of ['src/compiler-cache.mjs','src/javascript-host.mjs','src/wasm/host.mjs']) {
 const source=baselineRoot?await readFile(join(baselineRoot,path)):execFileSync('git',['show',`${baselineRef}:${path}`],{cwd:root});
 await writeFile(join(baselineDirectory,path),source);
 baselineFiles[path]=createHash('sha256').update(source).digest('hex');
}
const {JavaScriptCompilerHost:BaselineJS}=await import(pathToFileURL(join(baselineDirectory,'src/javascript-host.mjs')));
const {NativeWasmHost:BaselineWasm}=await import(pathToFileURL(join(baselineDirectory,'src/wasm/host.mjs')));

const source='public static class HostBenchmark {\n'+Array.from({length:120},(_,i)=>`public static int Method${i}(int n) { int sum=${i}; for (int k=0;k<n;k++) sum=unchecked(sum+k*(k+1)); return sum; }`).join('\n')+'\n}';
const summarize=values=>({samples:values.length,medianMs:[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)],minMs:Math.min(...values),maxMs:Math.max(...values),valuesMs:values});
const report={measuredAt:new Date().toISOString(),environment:{node:process.version,v8:process.versions.v8,cpu:cpus()[0].model},baseline:baselineRoot || baselineRef,baselineFiles,methodology:'120 independent C# integer-loop methods compiled by the bundled Roslyn .NET WASM runtime into one real PE. Baseline and current host implementations import the exact same current compiler engines. Warm direct-host same-PE emit requests alternate baseline/current ordering; each sample is 30 complete host emits, divided by 30. Seven samples follow five warm-up emits per host. Artifact generation and returned artifact cloning are included; C# compilation, initial inspection/emission and execution are excluded from the timed warm-emit phase. Pending same-PE managed inspection coalescing is independently verified by tests.',source,phases:{}};
const compiler=await createRoslyn({worker:false,baseUrl:new URL('../dist/',import.meta.url).href});
try {
 const pe=await compiler.compile(source,{assemblyName:'HostBenchmark',optimization:'release',outputKind:'library',emitPdb:false});assert.equal(pe.success,true,JSON.stringify(pe.diagnostics));
 report.peBytes=pe.pe.length;report.peSha256=createHash('sha256').update(pe.pe).digest('hex');
 const model=await compiler.inspect(pe);report.modelBytes=JSON.stringify(model).length;
 for(const [name,Old,Current]of [['javascript',BaselineJS,CurrentJS],['wasm',BaselineWasm,CurrentWasm]]) {
  const hostRecords=[['baseline',Old],['current',Current]].map(([version,Host])=>{let calls=0,inspectCalls=0,linkCalls=0;const host=new Host((method)=>{assert.equal(method,'InspectAssembly');calls++;return structuredClone(model);});const inspect=host.inspect.bind(host),link=host.link.bind(host);host.inspect=(...args)=>{inspectCalls++;return inspect(...args);};host.link=(...args)=>{linkCalls++;return link(...args);};return {version,host,times:[],counts:()=>({bridgeInspections:calls,hostInspections:inspectCalls,hostLinks:linkCalls})};});
  for(const record of hostRecords)for(let i=0;i<5;i++){const result=await record.host.emit({peBase64:pe.peBase64});assert.equal(result.success,true);}
  for(let sample=0;sample<7;sample++)for(let offset=0;offset<2;offset++) {
   const record=hostRecords[(sample+offset)%2],start=performance.now();
   for(let call=0;call<30;call++){const result=await record.host.emit({peBase64:pe.peBase64});assert.equal(result.success,true);assert.equal(result.cache.emitHit,true);}
   record.times.push((performance.now()-start)/30);
  }
  for(const record of hostRecords){report.phases[`${name}.${record.version}`]={...summarize(record.times),...record.counts()};record.host.dispose();}
  const baseline=report.phases[`${name}.baseline`],current=report.phases[`${name}.current`];
  report.phases[`${name}.improvement`]={speedup:baseline.medianMs/current.medianMs,reductionPercent:100*(1-current.medianMs/baseline.medianMs)};
  console.log(name,JSON.stringify({baseline,current,speedup:baseline.medianMs/current.medianMs}));
 }
 await writeFile(argument('--output') || join(root,'artifacts/host-performance-v7.json'),JSON.stringify(report,null,2)+'\n');
} finally {compiler.dispose();await rm(baselineDirectory,{recursive:true,force:true});}
