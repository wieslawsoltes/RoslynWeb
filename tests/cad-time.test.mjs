import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {isTemporalBuiltin,isTemporalField,invokeTemporalBuiltin,temporalField} from '../src/il/cad-time.mjs';
const revive=(_k,v)=>v?.$int64?BigInt(v.$int64):v;
const model=JSON.parse(await readFile(new URL('./cad-time-fixture.json',import.meta.url),'utf8'),revive),cases=JSON.parse(await readFile(new URL('./cad-time-baseline.json',import.meta.url),'utf8'),revive);
for(const optimize of [false,'blocks',true]){
 const program=compileAssembly(model,{strict:true,optimize});
 for(const item of cases)test(`temporal ${item.method}(${item.args}) JavaScript ${optimize}`,()=>assert.deepEqual(program.invoke('CadTimeFixture::'+item.method,item.args),item.result));
}
for(const optimize of [false,true])test(`temporal native Wasm ${optimize}`,async()=>{
 const artifact=compileWasm(model,{exports:[...new Set(cases.map(item=>item.method))],optimize}),program=await loadWasm(artifact.bytes);
 try{for(const item of cases)assert.deepEqual(program.invoke('CadTimeFixture::'+item.method,item.args),item.result,`${item.method}(${item.args})`);}finally{program.dispose();}
});
const DT='System.DateTime',TS='System.TimeSpan',ref=(t,n,p=[],r='System.Void',s=false)=>({declaringType:t,name:n,parameters:p.map(type=>({type})),returnType:r,isStatic:s});
test('temporal admission checks precise signatures and rejects calendar/timezone extensions',()=>{
 assert.equal(isTemporalBuiltin(ref(DT,'get_Now',[],DT,true)),true);
 for(const invalid of [ref(DT,'get_Now',[],DT,false),ref(DT,'get_Year',[],'System.String'),ref(TS,'FromTicks',['System.Double'],TS,true),ref(DT,'ToUniversalTime',[],DT),ref(DT,'.ctor',['System.Int32','System.Int32','System.Int32','System.Globalization.Calendar'])])assert.equal(isTemporalBuiltin(invalid),false);
 assert.equal(isTemporalField({declaringType:DT,name:'MaxValue',type:DT,isStatic:true}),true);
 assert.equal(isTemporalField({declaringType:DT,name:'MaxValue',type:DT,isStatic:false}),false);
 assert.equal(isTemporalField({declaringType:DT,name:'MaxValue',type:'System.Int64',isStatic:true}),false);
});
test('temporal static value reads are independent immutable copies',()=>{
 const f={declaringType:TS,name:'MaxValue',type:TS,isStatic:true},a=temporalField(f);a.$ticks=0n;
 assert.equal(temporalField(f).$ticks,(1n<<63n)-1n);
});
test('DateTime Now uses the host civil clock with Local kind, UtcNow uses UTC ticks',()=>{
 const original=Date.now,ms=Date.UTC(2024,1,29,23,59,58,123);Date.now=()=>ms;
 try{const date=new Date(ms),now=invokeTemporalBuiltin(null,ref(DT,'get_Now',[],DT,true),[],null).value,utc=invokeTemporalBuiltin(null,ref(DT,'get_UtcNow',[],DT,true),[],null).value;
 assert.equal(utc.$ticks,BigInt(ms)*10000n+621355968000000000n);assert.equal(utc.$kind,1);assert.equal(now.$kind,2);
 for(const [property,expected] of [['Year',date.getFullYear()],['Month',date.getMonth()+1],['Day',date.getDate()],['Hour',date.getHours()],['Minute',date.getMinutes()],['Second',date.getSeconds()],['Millisecond',date.getMilliseconds()]])assert.equal(invokeTemporalBuiltin(null,ref(DT,'get_'+property,[],'System.Int32'),[],now).value.value,expected);
 }finally{Date.now=original;}
});
