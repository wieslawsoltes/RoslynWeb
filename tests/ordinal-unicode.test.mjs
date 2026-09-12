import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compileAssembly } from '../src/il/compiler.mjs';
import { compileWasm, loadWasm } from '../src/wasm/index.js';
import { ordinalTableInfo, ordinalUpperPairs } from '../src/il/ordinal-tables.mjs';
import { ordinalUpperCodePoint, ordinalIgnoreCaseKey, compareOrdinalIgnoreCase, indexOfOrdinalIgnoreCase, ordinalIgnoreCaseEqualsAt } from '../src/il/ordinal.mjs';
const baseline=JSON.parse(await readFile(new URL('./ordinal-unicode-baseline.json',import.meta.url)));
const model=JSON.parse(await readFile(new URL('./ordinal-unicode-fixture.json',import.meta.url)));
const str=units=>units==null?null:String.fromCharCode(...units);
function check(program) {
 for(const x of baseline.comparisons)assert.deepEqual(program.invoke('OrdinalUnicodeFixture::Compare',[str(x.a),str(x.b)]),x.result,JSON.stringify(x));
 for(const x of baseline.searches)assert.deepEqual(program.invoke('OrdinalUnicodeFixture::Search',[str(x.text),str(x.needle),x.start,x.count]),x.result,JSON.stringify(x));
 for(const x of baseline.collections)assert.deepEqual(program.invoke('OrdinalUnicodeFixture::Collections',[str(x.a),str(x.b)]),x.result,JSON.stringify(x));
}
test('ordinal tables authenticate all 1,114,112 scalar/code-unit values and real C# fixture',async()=>{
 assert.equal(createHash('sha256').update(await readFile(new URL('./ordinal-unicode-fixture.cs',import.meta.url))).digest('hex'),baseline.sourceSha256);
 assert.equal(ordinalTableInfo.mappingSha256,baseline.mappingSha256);
 const values=Buffer.alloc(ordinalTableInfo.scalarCount*4);
 for(let c=0;c<ordinalTableInfo.scalarCount;c++)values.writeUInt32LE(ordinalUpperCodePoint(c),c*4);
 assert.equal(createHash('sha256').update(values).digest('hex'),ordinalTableInfo.mappingSha256);
 assert.equal(ordinalUpperPairs.length,ordinalTableInfo.mappingCount*2);
 for(let i=0;i<ordinalUpperPairs.length;i+=2){const a=String.fromCodePoint(ordinalUpperPairs[i]),b=String.fromCodePoint(ordinalUpperPairs[i+1]);assert.equal(ordinalIgnoreCaseKey(a),b);assert.equal(a.length,b.length);}
});
test('ordinal comparison and UTF16 search windows match native .NET directly',()=>{
 for(const x of baseline.comparisons)assert.equal(compareOrdinalIgnoreCase(str(x.a),str(x.b)),x.result[0]);
 for(const x of baseline.searches){const a=str(x.text),b=str(x.needle);assert.deepEqual([indexOfOrdinalIgnoreCase(a,b,x.start,x.count),indexOfOrdinalIgnoreCase(a,b)>=0?1:0,ordinalIgnoreCaseEqualsAt(a,b)?1:0,ordinalIgnoreCaseEqualsAt(a,b,a.length-b.length)?1:0],x.result,JSON.stringify(x));}
});
for(const optimize of [false,'blocks',true])test(`Unicode ordinal .NET oracle matches JavaScript optimize=${optimize}`,()=>check(compileAssembly(model,{strict:true,optimize})));
for(const optimize of [false,true])test(`Unicode ordinal .NET oracle matches native Wasm optimize=${optimize}`,async()=>{
 const p=await loadWasm(compileWasm(model,{exports:['OrdinalUnicodeFixture::Compare','OrdinalUnicodeFixture::Search','OrdinalUnicodeFixture::Collections'],optimize}).bytes);
 try{check(p);}finally{p.dispose();}
});
