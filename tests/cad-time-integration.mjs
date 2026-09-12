import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./cad-time-fixture.cs',import.meta.url),'utf8');
const drawingTime=await readFile(new URL('../vendor/netDxf/source/Units/DrawingTime.cs',import.meta.url),'utf8');
const cases=[];
const dateTicks=[0n,1n,9n,9999n,3155378975999999999n,621355967999999999n,621355968000000001n,638447759991234567n];
let seed=4321n;for(let i=0;i<40;i++){seed=(seed*6364136223846793005n+1442695040888963407n)&((1n<<64n)-1n);dateTicks.push(seed%3155378976000000000n);}
for(const ticks of dateTicks)for(const kind of [0,1,2])cases.push({method:'Calendar',args:[ticks,kind]});
for(const ticks of [0n,1n,-1n,9n,-9n,9999n,-9999n,937840001234n,-937840001234n,-(1n<<63n),(1n<<63n)-1n,...dateTicks.slice(8,24)])for(const method of ['Intervals','Text'])cases.push({method,args:[ticks]});
for(const method of ['Arithmetic','Constructors','Fields','Julian','ClockShape'])cases.push({method,args:[]});
for(let i=0;i<20;i++)cases.push({method:'Errors',args:[i]});
const bitView=new DataView(new ArrayBuffer(8));
for(const v of [0,-0,1e-8,-1e-8,.5,-.5,1.5,-1.5,2.5,-2.5,1e12,9223372036854775808/1e7,-9223372036854775808/1e7,NaN,Infinity,-Infinity]){bitView.setFloat64(0,v,true);const bits=bitView.getBigInt64(0,true);for(let kind=0;kind<6;kind++)cases.push({method:'IntervalEdges',args:[bits,kind]});}
const success=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const json=v=>JSON.stringify(v,(_k,v)=>typeof v==='bigint'?{$int64:String(v)}:v,2)+'\n';
const compiler=await createRoslyn({startupTimeoutMs:120000});
try{
 const assembly=success(await compiler.compile([{path:'Fixture.cs',text:source},{path:'DrawingTime.cs',text:drawingTime}],{assemblyName:'CadTimeFixture',outputKind:'library',optimization:'release',emitPdb:false,includeInspection:true}));
 const model=assembly.inspection??await compiler.inspect(assembly);
 for(const item of cases)item.result=success(await compiler.invoke(assembly.assemblyId,'CadTimeFixture',item.method,item.args)).result;
 if(process.argv.includes('--update')){await writeFile(new URL('./cad-time-fixture.json',import.meta.url),json(model));await writeFile(new URL('./cad-time-baseline.json',import.meta.url),json(cases));}
 for(const optimize of [false,'blocks',true]){const p=compileAssembly(model,{strict:true,optimize});for(const item of cases)assert.deepEqual(p.invoke('CadTimeFixture::'+item.method,item.args),item.result,json({method:item.method,args:item.args,optimize}));console.log('PASS temporal JavaScript',optimize,cases.length);}
 for(const optimize of [false,true]){const artifact=compileWasm(model,{exports:[...new Set(cases.map(x=>x.method))],optimize}),p=await loadWasm(artifact.bytes);try{for(const item of cases)assert.deepEqual(p.invoke('CadTimeFixture::'+item.method,item.args),item.result,json({method:item.method,args:item.args,optimize,nativeWasm:true}));}finally{p.dispose();}console.log('PASS temporal native Wasm',optimize,cases.length);}
}finally{await compiler.close();}
