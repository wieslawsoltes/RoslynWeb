// Actual unchanged netDxf DLL + real Roslyn C# compilation. Every result below
// is executed through .NET WebAssembly and strict generated JS/native Wasm.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRoslyn} from '../src/node/index.js';
import {loadWasm} from '../src/wasm/index.js';
const root=new URL('../',import.meta.url),checks=[];
const report={testedAt:new Date().toISOString(),scope:'Selected constructors, properties, entity mutations and event accessors in the actual pinned netDxf assembly. Cloning is a separate capability probe. Complete DXF document reading and writing are not claimed for generated backends.',checks};
const cases={
 LineLength:[[0,0,0,3,4,0],[1,2,3,4,6,3],[-12,7,4,2,-4,9],[0,0,0,0,0,0]],
 CircleArea:[[1],[7],[0.125],[10000]],
 ArcSweep:[[0,90],[350,10],[-30,450],[20,20]],
 TrueColorArgb:[[12,34,56],[0,0,0],[255,255,255],[255,0,127]],
 IndexColorArgb:[[1],[7],[23],[255]],
 PolylineMutation:[[]],LayerEvents:[[]],LayerAssignment:[[]],
 InvalidCircleConstructor:[[0],[-1]],InvalidCircleSetter:[[0],[-0.25]],
 InvalidLayerName:[[null],[''],['a/b'],['a|b']],InvalidLayerAssignment:[[]],InvalidLinetypeScale:[[]],InvalidVertexWidth:[[-1]],
};
const invalid=new Set(Object.keys(cases).filter(name=>name.startsWith('Invalid')));
let state=0x1a73d9;
const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
for(let i=0;i<12;i++){cases.LineLength.push(Array.from({length:6},()=>1000*(random()-.5)));cases.CircleArea.push([0.01+100*random()]);cases.ArcSweep.push([1440*(random()-.5),1440*(random()-.5)]);}
const succeeded=value=>{assert.equal(value.success,true,JSON.stringify(value.error??value.diagnostics));return value;};
const typeOf=error=>error?.$type??error?.managedType??error?.type;
const equal=(actual,expected,label)=>{if(typeof expected==='number')assert(Math.abs(actual-expected)<=Math.max(1,Math.abs(expected))*2e-13,`${label}: ${actual} != ${expected}`);else assert.deepEqual(actual,expected,label);};
let compiler;
try {
 compiler=await createRoslyn({startupTimeoutMs:90000});report.compiler=compiler.info;
 const bytes=new Uint8Array(await readFile(new URL('dist/netdxf/netDxf.netstandard.dll',root)));
 const provenance=JSON.parse(await readFile(new URL('vendor/netDxf/provenance.json',root),'utf8'));
 report.netDxf={repository:provenance.repository,commit:provenance.commit,sourceCount:provenance.sourceCount,assemblyBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 await compiler.addDll('netDxf.netstandard.dll',bytes);
 const source=await readFile(new URL('./netdxf-entities-fixture.cs',import.meta.url),'utf8');
 const assembly=succeeded(await compiler.compile(source,{assemblyName:'NetDxfEntitiesFixture',outputKind:'library',optimization:'release',emitPdb:false}));
 report.wrapper={assemblyBytes:assembly.pe.length,diagnostics:assembly.diagnostics};
 for(const [method,inputs] of Object.entries(cases)) {
  const oracle=[];
  for(const args of inputs){const result=await compiler.invoke(assembly.assemblyId,'NetDxfEntitiesFixture',method,args);if(invalid.has(method)){assert.equal(result.success,false,method+' must exercise an exception');assert(result.error?.type);oracle.push({args,error:result.error.type});}else oracle.push({args,result:succeeded(result).result});}
  for(const backend of ['javascript','native-wasm']) {
   const check={method,backend,strict:true,optimize:true,passed:false,cases:oracle.length};checks.push(check);let program;
   try {
    const started=performance.now();
    const artifact=await compiler[backend==='javascript'?'emitJavaScript':'emitWasm'](assembly,{exports:['NetDxfEntitiesFixture.'+method],strict:true,optimize:true,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href});
    assert.equal(artifact.analysis.diagnostics.length,0);check.diagnosticCount=0;check.selectedMethods=artifact.analysis.methodCount??artifact.analysis.methods;check.compileMilliseconds=performance.now()-started;
    program=backend==='javascript'?(await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(artifact.source))).createAssembly():await loadWasm(artifact.bytes);
    check.results=[];
    for(const expected of oracle){let value,error;try{value=await program.invoke('NetDxfEntitiesFixture::'+method,expected.args);}catch(caught){error=caught;}
     if(expected.error)assert.equal(typeOf(error),expected.error,`${backend} ${method}: ${error?.message??'did not throw'}`);
     else {if(error)throw error;equal(value,expected.result,backend+' '+method);}
     check.results.push({...expected,...(error?{actualError:typeOf(error)}:{actual:value})});
    }
    check.passed=true;console.log('PASS',backend,method,oracle.length+' cases',check.selectedMethods+' selected methods');
   }catch(error){check.error={message:error.message,diagnostics:error.diagnostics??error.details?.diagnostics??[]};console.error('FAIL',backend,method,error.message);process.exitCode=1;}finally{program?.dispose?.();}
  }
 }
 report.additionalProbes=[];
 const cloneOracle=succeeded(await compiler.invoke(assembly.assemblyId,'NetDxfEntitiesFixture','CircleClone',[])).result;
 for(const backend of ['javascript','native-wasm']) {
  const probe={method:'CircleClone',backend,managedResult:cloneOracle};report.additionalProbes.push(probe);let program;
  try {
   const artifact=await compiler[backend==='javascript'?'emitJavaScript':'emitWasm'](assembly,{exports:['NetDxfEntitiesFixture.CircleClone'],strict:true,optimize:true,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href});
   program=backend==='javascript'?(await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(artifact.source))).createAssembly():await loadWasm(artifact.bytes);
   probe.result=await program.invoke('NetDxfEntitiesFixture::CircleClone',[]);equal(probe.result,cloneOracle,backend+' CircleClone');probe.supported=true;
  }catch(error){const diagnostics=error.diagnostics??error.details?.diagnostics??[];if(!diagnostics.length)throw error;probe.supported=false;probe.diagnostics=diagnostics;probe.diagnosticCount=diagnostics.length;probe.reason='Cloning reaches ICloneable dispatch, framework enumerators and other framework APIs outside this selected entity scope.';}
  finally{program?.dispose?.();}
  console.log('PROBE',backend,'CircleClone',probe.supported?'supported':probe.diagnosticCount+' explicit unsupported diagnostics');
 }
}catch(error){checks.push({method:'setup or managed oracle',passed:false,error:{message:error.message}});console.error(error.message);process.exitCode=1;}
finally{await compiler?.close();report.passed=checks.length===Object.keys(cases).length*2&&checks.every(check=>check.passed);report.comparisons=checks.filter(check=>check.passed).reduce((sum,check)=>sum+check.cases,0);await writeFile(new URL('docs/netdxf-entities-verification.json',root),JSON.stringify(report,null,2)+'\n');console.log(checks.filter(check=>check.passed).length+'/'+checks.length+' entity backend checks passed; '+report.comparisons+' generated execution comparisons.');}
