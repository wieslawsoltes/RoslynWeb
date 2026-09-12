// Checked with TypeScript --strict --noEmit --module NodeNext --target ES2022.
import {createRoslyn,compileAssembly,type AssemblyModel,type JavaScriptArtifact,type JavaScriptOptimizationStats} from '@roslynweb/core';
import {compileJavaScriptModule,generateModule,ILAssemblyBuilder,DynamicMethodBuilder,type ILAnalysis} from '@roslynweb/core/il';
import {compileWasm,loadWasm,type WasmOptimizationStats} from '@roslynweb/core/wasm';
import {createNetDxf,createNetDxfKernel,createDxfRenderer,tessellateDxfScene,type DxfGeometry,type NetDxfSession} from '@roslynweb/core/dxf';
import {createRoslyn as createNodeRoslyn,type NodeRoslynCompiler} from '@roslynweb/core/node';

const nodeCompiler:NodeRoslynCompiler=await createNodeRoslyn({baseUrl:'./dist',worker:true,onWorkerOutput(text,stream){void[text,stream];}});
await nodeCompiler.compile('System.Console.WriteLine(42);');
await nodeCompiler.close();
// @ts-expect-error Node requires a terminable worker.
createNodeRoslyn({worker:false});
// @ts-expect-error Node supplies its own transport rather than accepting a browser Worker constructor.
createNodeRoslyn({Worker:globalThis.Worker});

const compiler=await createRoslyn({worker:true});
const javascript=await compiler.compileToJavaScript('public static class Math { public static int Add(int a,int b)=>a+b; }',{outputKind:'library',javascript:{optimize:true,runtimeImport:'./src/il/runtime.mjs'}});
if(javascript.success){
  const artifact:JavaScriptArtifact=javascript;
  const source:string=artifact.source;
  const reused:boolean=artifact.cache.emitHit;
  const report:JavaScriptOptimizationStats=artifact.optimization;
  await compiler.run(artifact,{backend:'javascript',optimize:'blocks'});
  void[source,reused,report];
}else{
  const stage:'csharp'|'javascript'=javascript.stage;
  const messages:string[]|undefined=javascript.diagnostics?.map(item=>item.message);
  void[stage,messages];
  // @ts-expect-error Failed compilations do not expose runnable generated source.
  javascript.source;
}
const model:AssemblyModel={name:'Numbers',types:[]};
const blueprint=compileJavaScriptModule(model,{strict:true,optimize:'blocks'});
const analysis:ILAnalysis=blueprint.analysis;
const runtime=blueprint.createRuntime({maxInstructions:100000,output:(text,meta)=>{void[text,meta?.newline];}});
const result:unknown=runtime.invoke('Math::Add',[20,22]);
const emitted:string=generateModule(model,{optimize:false,runtimeImport:'./runtime.mjs'});
compileAssembly(model,{optimize:true});
const native=compileWasm(model,{optimize:true});
const stats:WasmOptimizationStats=native.optimization;
const loaded=await loadWasm(native,{maxInstructions:100000});
loaded.invoke('Math::Add',[20,22]);
const builder=new ILAssemblyBuilder('Generated');
const method=builder.defineType('Main').defineMethod('Answer',{returnType:'System.Int32'});
method.emit('ldc.i4',42).emit('ret');builder.setEntryPoint(method).compile({optimize:true});
new DynamicMethodBuilder('Answer','System.Int32').emit('ldc.i4',42).emit('ret');
// @ts-expect-error JavaScript optimization is boolean or the documented blocks mode.
compileJavaScriptModule(model,{optimize:'fast'});
// @ts-expect-error Wasm optimization is a boolean.
compileWasm(model,{optimize:'blocks'});
// @ts-expect-error Worker emission cannot carry non-serializable external callbacks.
await compiler.compileToJavaScript('class C {}',{javascript:{externals:{'C::M':()=>0}}});
void[analysis,result,emitted,stats];
const dxf:NetDxfSession=await createNetDxf({compiler,compile:true,onProgress(event){void[event.stage,event.sourceCount];}});
const drawing=await dxf.createSample();
const geometry:DxfGeometry=tessellateDxfScene(drawing.scene,{tolerance:0.01});
const kernel=await createNetDxfKernel({compiler,backend:'native-wasm'});
const distance:number=await kernel.invoke('Distance2',[0,0,3,4]);kernel.dispose();void distance;
const binaryDxf:Uint8Array=await drawing.export({binary:true});
const renderer=await createDxfRenderer(document.createElement('canvas'),{onError(error){void error.message;}});
renderer.setGeometry(geometry);renderer.setLayerVisibility('Plate',false);renderer.fit();renderer.zoomAt(2,100,100);
renderer.dispose();await drawing.dispose();await dxf.dispose();
// @ts-expect-error Full DXF sessions require an initialized compiler.
createNetDxf({compile:true});
// @ts-expect-error DXF export is text or binary, not an arbitrary serializer name.
drawing.export({format:'json'});
void binaryDxf;
compiler.dispose();
