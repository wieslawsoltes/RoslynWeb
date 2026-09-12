import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {analyzeAssembly,compileAssembly} from '../src/il/compiler.mjs';
import {isCollectionsBuiltin,invokeCollectionsBuiltin} from '../src/il/collections-extra.mjs';
import {i4} from '../src/il/runtime.mjs';
const model=JSON.parse(await readFile(new URL('./il-collections-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(await readFile(new URL('./il-collections-native-baseline.json',import.meta.url),'utf8'));
const ref=(declaringType,name,parameters=[],returnType='System.Void')=>({declaringType,name,parameters:parameters.map(type=>({type})),returnType});
const G='System.Collections.Generic.';

test('real Roslyn collection fixture passes strict compatibility analysis',()=>assert.deepEqual(analyzeAssembly(model).diagnostics,[]));
for(const [name,expected] of Object.entries(baseline.results))test(`C# collections native differential: ${name}`,()=>{const rt=compileAssembly(model,{strict:true});assert.equal(String(rt.invoke('CollectionsFixture::'+name)),expected);});

test('collection overload admission rejects serialization, synchronous wrappers and culture-based string constructors',()=>{
 assert.equal(isCollectionsBuiltin(ref(G+'Queue`1<System.Int32>','.ctor',['System.Int32'])),true);
 assert.equal(isCollectionsBuiltin(ref(G+'SortedSet`1<System.Int32>','GetViewBetween',['System.Int32','System.Int32'])),true);
 assert.equal(isCollectionsBuiltin(ref(G+'SortedSet`1<System.String>','.ctor',[])),false);
 assert.equal(isCollectionsBuiltin(ref(G+'Comparer`1<System.String>','get_Default',[])),false);
 assert.equal(isCollectionsBuiltin(ref('System.StringComparer','get_CurrentCulture',[])),false);
 assert.equal(isCollectionsBuiltin(ref(G+'SortedSet`1<System.Int32>','.ctor',['System.Runtime.Serialization.SerializationInfo','System.Runtime.Serialization.StreamingContext'])),false);
 assert.equal(isCollectionsBuiltin(ref(G+'Queue`1<System.Int32>','Synchronized',[G+'Queue`1<System.Int32>'])),false);
 assert.equal(isCollectionsBuiltin(ref(G+'LinkedListNode`1<System.Int32>','get_ValueRef',[])),false);
});

test('collection limits remain bounded while ordinal casing supports Unicode',()=>{
 const rt=compileAssembly(model,{strict:true,maxArrayLength:2});
 assert.throws(()=>rt.invoke('CollectionsFixture::QueueOrder'),e=>e.runtimeLimitation&&/maximum length/.test(e.message));
 const comparer=invokeCollectionsBuiltin(rt,ref('System.StringComparer','get_OrdinalIgnoreCase'),[],null).value;
 assert.equal(rt.raw(invokeCollectionsBuiltin(rt,ref('System.StringComparer','Compare',['System.String','System.String']),['é','É'],comparer).value),0);
 const ordinal=invokeCollectionsBuiltin(rt,ref('System.StringComparer','get_Ordinal'),[],null).value;
 assert.equal(rt.raw(invokeCollectionsBuiltin(rt,ref('System.StringComparer','Compare',['System.String','System.String']),['a','z'],ordinal).value),-25);
});

test('set range views remain live and forbid adding values beyond their bounds',()=>{
 const rt=compileAssembly(model,{strict:true});const type=G+'SortedSet`1<System.Int32>',self=rt.allocate(type);
 const call=(name,args=[],types=[])=>invokeCollectionsBuiltin(rt,ref(type,name,types),args,self).value;
 call('.ctor');call('Add',[i4(2)],['System.Int32']);
 const view=call('GetViewBetween',[i4(1),i4(3)],['System.Int32','System.Int32']);
 call('Add',[i4(3)],['System.Int32']);
 assert.equal(rt.raw(invokeCollectionsBuiltin(rt,ref(type,'get_Count'),[],view).value),2);
 assert.throws(()=>invokeCollectionsBuiltin(rt,ref(type,'Add',['System.Int32']),[i4(4)],view),e=>e.$type==='System.ArgumentOutOfRangeException');
});

test('unrelated IEnumerator implementations pass through without interception',()=>{
 const rt=compileAssembly(model,{strict:true});
 assert.deepEqual(invokeCollectionsBuiltin(rt,ref('System.Collections.IEnumerator','MoveNext'),[],{$enumerator:true,$iterator:[][Symbol.iterator]()}),{handled:false});
});
