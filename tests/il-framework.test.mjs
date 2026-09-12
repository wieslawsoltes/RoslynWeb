import test from 'node:test';
import assert from 'node:assert/strict';
import { ILRuntime, i4, i8, r8, toJS, copyValue } from '../src/il/runtime.mjs';
import { isExtendedBuiltin, invokeExtendedBuiltin, sequenceItems } from '../src/il/framework.mjs';

const rt = () => new ILRuntime({name:'FrameworkTests',types:[]});
const ref = (type,name,p=[],returnType='System.Void',isStatic=false,genericArguments=[]) => ({declaringType:type,name,parameters:p.map(type=>({type})),returnType,isStatic,genericArguments});
function invoke(runtime,type,name,p,args=[],self=null,returnType='System.Void',isStatic=false,generics=[]){const result=invokeExtendedBuiltin(runtime,ref(type,name,p,returnType,isStatic,generics),args,self,'call');assert.equal(result.handled,true,`${type}.${name} overload must be handled`);return result.value;}
function create(runtime,type,p=[],args=[]){const self=runtime.allocate(type);invoke(runtime,type,'.ctor',p,args,self);return self;}
const array = (items,type='System.Int32') => ({$type:`${type}[]`,$array:true,elementType:type,items:items.map(v=>typeof v==='number'?i4(v):v)});
const values = (runtime,source) => [...sequenceItems(runtime,source)].map(toJS);
const sourceType='System.Collections.Generic.IEnumerable`1<System.Int32>';
const func='System.Func`2<System.Int32,System.Int32>', predicate='System.Func`2<System.Int32,System.Boolean>';
function linq(runtime,name,args,p,returnType=sourceType,generics=['System.Int32']) { return invoke(runtime,'System.Linq.Enumerable',name,p,args,null,returnType,true,generics); }
const errorIs = type => e => e.$type === `System.${type}`;

// Constructors, duplicate-key behavior, nulls, value equality and writable out parameters.
test('dictionary uses numeric value keys and implements duplicate/overwrite/TryGetValue semantics',()=>{
  const r=rt(),t='System.Collections.Generic.Dictionary`2<System.Int32,System.String>',d=create(r,t);
  invoke(r,t,'Add',['!0','!1'],[i4(7),'seven'],d);
  assert.equal(invoke(r,t,'get_Item',['!0'],[i4(7)],d,'!1'),'seven');
  assert.throws(()=>invoke(r,t,'Add',['!0','!1'],[i4(7),'duplicate'],d),errorIs('ArgumentException'));
  assert.equal(toJS(invoke(r,t,'TryAdd',['!0','!1'],[i4(7),'ignored'],d,'System.Boolean')),0);
  invoke(r,t,'set_Item',['!0','!1'],[i4(7),'updated'],d);
  let out='sentinel'; const address={$byref:true,type:'System.String',get:()=>out,set:v=>out=v};
  assert.equal(toJS(invoke(r,t,'TryGetValue',['!0','!1&'],[i4(7),address],d,'System.Boolean')),1);assert.equal(out,'updated');
  assert.equal(toJS(invoke(r,t,'TryGetValue',['!0','!1&'],[i4(8),address],d,'System.Boolean')),0);assert.equal(out,null);
  assert.throws(()=>invoke(r,t,'get_Item',['!0'],[i4(8)],d,'!1'),errorIs('Collections.Generic.KeyNotFoundException'));
  assert.throws(()=>invoke(r,t,'ContainsKey',['!0'],[null],d,'System.Boolean'),errorIs('ArgumentNullException'));
});
test('dictionary enumeration detects inserts immediately and enumerator value copies are independent',()=>{
  const r=rt(),t='System.Collections.Generic.Dictionary`2<System.Int32,System.Int32>',d=create(r,t),eType=t.replace('<','+Enumerator<');
  for(const n of [1,2])invoke(r,t,'Add',['!0','!1'],[i4(n),i4(n*10)],d);
  const e=invoke(r,t,'GetEnumerator',[],[],d,eType);
  invoke(r,t,'Add',['!0','!1'],[i4(3),i4(30)],d);
  assert.throws(()=>invoke(r,eType,'MoveNext',[],[],e,'System.Boolean'),errorIs('InvalidOperationException'));
  const first=invoke(r,t,'GetEnumerator',[],[],d,eType);
  assert.equal(toJS(invoke(r,eType,'MoveNext',[],[],first,'System.Boolean')),1);
  const second=copyValue(first);invoke(r,eType,'MoveNext',[],[],first,'System.Boolean');
  assert.equal(toJS(invoke(r,eType,'get_Current',[],[],first,'pair').fields.key),2);
  assert.equal(toJS(invoke(r,eType,'get_Current',[],[],second,'pair').fields.key),1);
  invoke(r,t,'Remove',['!0'],[i4(2)],d,'System.Boolean');
  assert.equal(toJS(invoke(r,eType,'MoveNext',[],[],second,'System.Boolean')),1);
  assert.equal(toJS(invoke(r,eType,'get_Current',[],[],second,'pair').fields.key),3);
});
test('dictionary live key/value views reflect later changes',()=>{
  const r=rt(),t='System.Collections.Generic.Dictionary`2<System.String,System.Int32>',d=create(r,t);
  const keys=invoke(r,t,'get_Keys',[],[],d,'System.Collections.Generic.Dictionary`2+KeyCollection<System.String,System.Int32>');
  const vals=invoke(r,t,'get_Values',[],[],d,'System.Collections.Generic.Dictionary`2+ValueCollection<System.String,System.Int32>');
  invoke(r,t,'Add',['!0','!1'],['alpha',i4(11)],d);assert.deepEqual(values(r,keys),['alpha']);assert.deepEqual(values(r,vals),[11]);
  invoke(r,t,'Clear',[],[],d);assert.deepEqual(values(r,keys),[]);
});
test('hashset handles deduplication, null and NaN equality, set operations and proper subset predicates',()=>{
  const r=rt(),t='System.Collections.Generic.HashSet`1<System.Object>',s=create(r,t);
  for(const v of [null,null,r8(NaN),r8(NaN),'x'])invoke(r,t,'Add',['!0'],[v],s,'System.Boolean');
  assert.equal(toJS(invoke(r,t,'get_Count',[],[],s,'System.Int32')),3);
  invoke(r,t,'IntersectWith',['System.Collections.Generic.IEnumerable`1<!0>'],[array([null,'x'],'System.Object')],s);
  assert.deepEqual(values(r,s),[null,'x']);
  invoke(r,t,'SymmetricExceptWith',['System.Collections.Generic.IEnumerable`1<!0>'],[array(['x','y','y'],'System.Object')],s);
  assert.deepEqual(values(r,s),[null,'y']);
  assert.equal(toJS(invoke(r,t,'IsProperSubsetOf',['System.Collections.Generic.IEnumerable`1<!0>'],[array([null,'y','z'],'System.Object')],s,'System.Boolean')),1);
});
test('value-type dictionary keys are copied and use field value equality',()=>{
  const r=rt(),t='System.Collections.Generic.Dictionary`2<Point,System.String>',d=create(r,t),key={$type:'Point',$valueType:true,fields:{x:i4(1),y:i4(2)}};
  invoke(r,t,'Add',['!0','!1'],[key,'point'],d);key.fields.x=i4(99);
  assert.equal(invoke(r,t,'get_Item',['!0'],[{$type:'Point',$valueType:true,fields:{x:i4(1),y:i4(2)}}],d,'System.String'),'point');
});
test('list range edits, predicates and self AddRange preserve values',()=>{
  const r=rt(),t='System.Collections.Generic.List`1<System.Int32>',list=create(r,t,[sourceType],[array([1,2,3])]);
  invoke(r,t,'AddRange',[sourceType],[list],list);assert.deepEqual(values(r,list),[1,2,3,1,2,3]);
  assert.equal(toJS(invoke(r,t,'RemoveAll',['System.Predicate`1<System.Int32>'],[n=>n%2===0],list,'System.Int32')),2);
  invoke(r,t,'Insert',['System.Int32','!0'],[i4(2),i4(9)],list);assert.deepEqual(values(r,list),[1,3,9,1,3]);
  invoke(r,t,'RemoveRange',['System.Int32','System.Int32'],[i4(1),i4(3)],list);assert.deepEqual(values(r,list),[1,3]);
});
test('LINQ is deferred, repeatable, supports index-aware delegates, and Take short circuits',()=>{
  const r=rt(),a=array([3,4,5,6]);let calls=0;
  const filtered=linq(r,'Where',[a,(n,i)=>{calls++;return i%2===0;}],[sourceType,'System.Func`3<System.Int32,System.Int32,System.Boolean>']);
  const selected=linq(r,'Select',[filtered,n=>n*10],[sourceType,func]);
  const one=linq(r,'Take',[selected,i4(1)],[sourceType,'System.Int32']);
  assert.equal(calls,0);assert.deepEqual(values(r,one),[30]);assert.equal(calls,1);assert.deepEqual(values(r,selected),[30,50]);assert.equal(calls,5);
  a.items[0]=i4(9);assert.deepEqual(values(r,one),[90]);
});
test('LINQ validation happens before deferred iteration',()=>{
  const r=rt();assert.throws(()=>linq(r,'Where',[array([]),null],[sourceType,predicate]),errorIs('ArgumentNullException'));
  assert.throws(()=>linq(r,'Concat',[array([]),null],[sourceType,sourceType]),errorIs('ArgumentNullException'));
  assert.throws(()=>linq(r,'Range',[i4(2147483647),i4(2)],['System.Int32','System.Int32']),errorIs('ArgumentOutOfRangeException'));
});
test('LINQ Distinct/Except/Intersect preserve first occurrence order and source uniqueness',()=>{
  const r=rt(),a=array([4,1,4,2,3,2]),b=array([2,4,4]);
  assert.deepEqual(values(r,linq(r,'Distinct',[a],[sourceType])),[4,1,2,3]);
  assert.deepEqual(values(r,linq(r,'Except',[a,b],[sourceType,sourceType])),[1,3]);
  assert.deepEqual(values(r,linq(r,'Intersect',[a,b],[sourceType,sourceType])),[4,2]);
  assert.deepEqual(values(r,linq(r,'Union',[a,array([5,1])],[sourceType,sourceType])),[4,1,2,3,5]);
});
test('LINQ stable OrderBy/ThenBy caches keys once and remains deferred',()=>{
  const r=rt(),a=array([31,22,11,24,13]);let calls=0;
  const ordered=linq(r,'OrderBy',[a,n=>{calls++;return n%10;}],[sourceType,func],'System.Linq.IOrderedEnumerable`1<System.Int32>',['System.Int32','System.Int32']);
  const result=linq(r,'ThenByDescending',[ordered,n=>n],['System.Linq.IOrderedEnumerable`1<System.Int32>',func],'System.Linq.IOrderedEnumerable`1<System.Int32>',['System.Int32','System.Int32']);
  assert.equal(calls,0);assert.deepEqual(values(r,result),[31,11,22,13,24]);assert.equal(calls,5);
});
test('LINQ First/Single/Any/All count matches and reject empty or multiple matches',()=>{
  const r=rt(),a=array([1,2,3]);
  assert.equal(toJS(linq(r,'First',[a,n=>n>1],[sourceType,predicate],'System.Int32')),2);
  assert.equal(toJS(linq(r,'Single',[a,n=>n===3],[sourceType,predicate],'System.Int32')),3);
  assert.throws(()=>linq(r,'Single',[a],[sourceType],'System.Int32'),errorIs('InvalidOperationException'));
  assert.throws(()=>linq(r,'First',[array([])],[sourceType],'System.Int32'),errorIs('InvalidOperationException'));
  assert.equal(toJS(linq(r,'FirstOrDefault',[array([])],[sourceType],'System.Int32')),0);
  assert.equal(toJS(linq(r,'LongCount',[a],[sourceType],'System.Int64')),3n);
  assert.equal(toJS(linq(r,'All',[array([]),()=>false],[sourceType,predicate],'System.Boolean')),1);
});
test('LINQ Sum and Average preserve integer overflow and 64-bit accumulation',()=>{
  const r=rt();assert.equal(toJS(linq(r,'Sum',[array([1,2,3])],[sourceType],'System.Int32')),6);
  assert.throws(()=>linq(r,'Sum',[array([2147483647,1])],[sourceType],'System.Int32'),errorIs('OverflowException'));
  assert.equal(toJS(linq(r,'Average',[array([2147483647,2147483647])],[sourceType],'System.Double')),2147483647);
  const longs=array([i8(9007199254740993n),i8(1n)],'System.Int64');
  assert.equal(toJS(linq(r,'Sum',[longs],['System.Collections.Generic.IEnumerable`1<System.Int64>'],'System.Int64')),9007199254740994n);
  assert.throws(()=>linq(r,'Average',[array([])],[sourceType],'System.Double'),errorIs('InvalidOperationException'));
});
test('LINQ GroupBy, Join, GroupJoin and ToDictionary execute selected delegates',()=>{
  const r=rt(),a=array([1,2,3,4]);
  const groups=values(r,linq(r,'GroupBy',[a,n=>n%2],[sourceType,func],'System.Collections.Generic.IEnumerable`1<System.Linq.IGrouping`2<System.Int32,System.Int32>>',['System.Int32','System.Int32']));
  assert.deepEqual(groups.map(g=>[toJS(g.$groupKey),values(r,g)]),[[1,[1,3]],[0,[2,4]]]);
  const join=linq(r,'Join',[a,array([2,4]),n=>n,n=>n,(a,b)=>a+b],[sourceType,sourceType,func,func,'System.Func`3<System.Int32,System.Int32,System.Int32>']);
  assert.deepEqual(values(r,join),[4,8]);
  const d=linq(r,'ToDictionary',[a,n=>n,n=>n*10],[sourceType,func,func],'System.Collections.Generic.Dictionary`2<System.Int32,System.Int32>',['System.Int32','System.Int32','System.Int32']);
  assert.equal(invoke(r,d.$type,'get_Item',['!0'],[i4(3)],d,'System.Int32').value,30);
});
test('LINQ SelectMany/Zip and Aggregate handle nested sequences and accumulation',()=>{
  const r=rt(),a=array([1,2]);
  const selected=linq(r,'SelectMany',[a,n=>array([n,n+10]),(outer,inner)=>outer+inner],[sourceType,'System.Func`2<System.Int32,System.Collections.Generic.IEnumerable`1<System.Int32>>','System.Func`3<System.Int32,System.Int32,System.Int32>']);
  assert.deepEqual(values(r,selected),[2,12,4,14]);
  assert.deepEqual(values(r,linq(r,'Zip',[a,array([10,20,30]),(a,b)=>a+b],[sourceType,sourceType,'System.Func`3<System.Int32,System.Int32,System.Int32>'])),[11,22]);
  assert.equal(toJS(linq(r,'Aggregate',[a,i4(10),(a,b)=>a*b],[sourceType,'System.Int32','System.Func`3<System.Int32,System.Int32,System.Int32>'],'System.Int32')),20);
});
test('DateTime calendar constructors keep exact ticks, kind and sub-millisecond parts',()=>{
  const r=rt(),type='System.DateTime',d=create(r,type,['System.Int64','System.DateTimeKind'],[i8(638448479999999999n),i4(1)]);
  assert.equal(toJS(invoke(r,type,'get_Ticks',[],[],d,'System.Int64')),638448479999999999n);
  assert.equal(toJS(invoke(r,type,'get_Kind',[],[],d,'System.DateTimeKind')),1);
  assert.equal(toJS(invoke(r,type,'get_Microsecond',[],[],d,'System.Int32')),999);
  assert.equal(toJS(invoke(r,type,'get_Nanosecond',[],[],d,'System.Int32')),900);
  const e=create(r,type,Array(8).fill('System.Int32'),[2024,2,29,13,14,15,123,456].map(i4));
  assert.equal(toJS(invoke(r,type,'get_Year',[],[],e,'System.Int32')),2024);
  assert.equal(toJS(invoke(r,type,'get_DayOfYear',[],[],e,'System.Int32')),60);
  assert.equal(toJS(invoke(r,type,'get_Microsecond',[],[],e,'System.Int32')),456);
  assert.throws(()=>create(r,type,['System.Int32','System.Int32','System.Int32'],[2023,2,29].map(i4)),errorIs('ArgumentOutOfRangeException'));
});
test('DateTime AddMonths clips calendar day, subtraction returns exact TimeSpan',()=>{
  const r=rt(),type='System.DateTime',d=create(r,type,Array(3).fill('System.Int32'),[2024,1,31].map(i4));
  const next=invoke(r,type,'AddMonths',['System.Int32'],[i4(1)],d,type);
  assert.equal(toJS(invoke(r,type,'get_Day',[],[],next,'System.Int32')),29);
  const delta=invoke(r,type,'Subtract',[type],[d],next,'System.TimeSpan');assert.equal(delta.$ticks,29n*864000000000n);
  const max=create(r,type,['System.Int64'],[i8(3155378975999999999n)]);assert.throws(()=>invoke(r,type,'AddTicks',['System.Int64'],[i8(1n)],max,type),errorIs('ArgumentOutOfRangeException'));
});
test('DateTime year 1 and before Unix epoch do not lose days near midnight',()=>{
  const r=rt(),t='System.DateTime';
  for(const [ticks,year,month,day] of [[0n,1,1,1],[1n,1,1,1],[621355967999999999n,1969,12,31],[621355968000000001n,1970,1,1]]){
    const d=create(r,t,['System.Int64'],[i8(ticks)]);
    assert.deepEqual(['Year','Month','Day'].map(n=>toJS(invoke(r,t,`get_${n}`,[],[],d,'System.Int32'))),[year,month,day]);
  }
});
test('TimeSpan exact signed ticks, component truncation, constant format and overflow',()=>{
  const r=rt(),t='System.TimeSpan',s=create(r,t,['System.Int64'],[i8(-937840001234n)]);
  assert.deepEqual(['Days','Hours','Minutes','Seconds','Milliseconds','Microseconds','Nanoseconds'].map(n=>toJS(invoke(r,t,`get_${n}`,[],[],s,'System.Int32'))),[-1,-2,-3,-4,0,-123,-400]);
  assert.equal(invoke(r,t,'ToString',[],[],s,'System.String'),'-1.02:03:04.0001234');
  const min=create(r,t,['System.Int64'],[i8(-(1n<<63n))]);assert.throws(()=>invoke(r,t,'Negate',[],[],min,t),errorIs('OverflowException'));
  assert.throws(()=>invoke(r,t,'FromSeconds',['System.Double'],[r8(Infinity)],null,t,true),errorIs('OverflowException'));
});
test('framework adapter rejects unsupported overloads instead of advertising unrestricted framework parity',()=>{
  assert.equal(isExtendedBuiltin(ref('System.Collections.Generic.Dictionary`2<System.String,System.Int32>','.ctor',['System.Runtime.Serialization.SerializationInfo','System.Runtime.Serialization.StreamingContext'])),false);
  assert.equal(isExtendedBuiltin(ref('System.Collections.Generic.Dictionary`2<System.String,System.Int32>','.ctor',['System.Collections.Generic.IEqualityComparer`1<System.String>'])),true);
  assert.equal(isExtendedBuiltin(ref('System.Linq.Enumerable','Distinct',[sourceType,'System.Collections.Generic.IEqualityComparer`1<System.Int32>'])),false);
  assert.equal(isExtendedBuiltin(ref('System.Linq.Enumerable','Sum',['System.Collections.Generic.IEnumerable`1<System.Decimal>'],'System.Decimal',true)),false);
  assert.equal(isExtendedBuiltin(ref('System.DateTime','ToString',['System.String'],'System.String')),false);
  assert.equal(isExtendedBuiltin(ref('System.Text.RegularExpressions.Regex','IsMatch',['System.String','System.String'],'System.Boolean',true)),false);
});

test('framework collection allocation and sequence execution enforce configurable resource budgets',()=>{
  const r=new ILRuntime({name:'Budgets',types:[]},{maxArrayLength:2,maxSequenceIterations:4,maxInstructions:100});
  const range=linq(r,'Range',[i4(1),i4(10)],['System.Int32','System.Int32']);
  assert.throws(()=>linq(r,'ToArray',[range],[sourceType],'System.Int32[]'),e=>e.details?.runtimeLimitation||e.runtimeLimitation);
  assert.throws(()=>linq(r,'Count',[range],[sourceType],'System.Int32'),e=>e.details?.runtimeLimitation||e.runtimeLimitation);
  const t='System.Collections.Generic.HashSet`1<System.Int32>',set=create(r,t);
  for(const n of [1,2])invoke(r,t,'Add',['!0'],[i4(n)],set,'System.Boolean');
  assert.throws(()=>invoke(r,t,'Add',['!0'],[i4(3)],set,'System.Boolean'),e=>e.details?.runtimeLimitation||e.runtimeLimitation);
  for(let n=0;n<10;n++){invoke(r,t,'Remove',['!0'],[i4(1)],set,'System.Boolean');invoke(r,t,'Add',['!0'],[i4(1)],set,'System.Boolean');}
  assert.equal(set.$entries.length,2);
});

test('boxed numeric keys distinguish CLR types and LINQ casts enforce non-nullable value types',()=>{
  const r=rt(),t='System.Collections.Generic.HashSet`1<System.Object>',s=create(r,t);
  for(const boxed of [{$box:true,$type:'System.Int32',value:i4(1)},{$box:true,$type:'System.Boolean',value:i4(1)}])invoke(r,t,'Add',['!0'],[boxed],s,'System.Boolean');
  assert.equal(toJS(invoke(r,t,'get_Count',[],[],s,'System.Int32')),2);
  const oftype=linq(r,'OfType',[array([0,1],'System.Boolean')],['System.Collections.IEnumerable'],'System.Collections.Generic.IEnumerable`1<System.Boolean>',['System.Boolean']);
  assert.deepEqual(values(r,oftype),[0,1]);
  const cast=linq(r,'Cast',[array([null],'System.Object')],['System.Collections.IEnumerable'],sourceType,['System.Int32']);
  assert.throws(()=>values(r,cast),errorIs('NullReferenceException'));
});
