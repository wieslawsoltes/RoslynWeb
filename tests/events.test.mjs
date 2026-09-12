import assert from 'node:assert/strict';
import test from 'node:test';
import {createRuntime} from '../src/il/runtime.mjs';
import {isBuiltinCandidate} from '../src/il/compiler.mjs';
import {selectJavaScriptExports} from '../src/il/reachability.mjs';
import {eventBuiltin,invokeEventBuiltin,delegateEquals} from '../src/il/events.mjs';
const runtime=()=>createRuntime({name:'EventUnit',types:[]});
const ref=(name,parameters,returnType='System.Delegate',declaringType='System.Delegate',isStatic=true,extra={})=>({name,declaringType,isStatic,parameters:parameters.map(type=>({type})),returnType,genericParameterCount:0,...extra});
const delegate=(name,target=null,type='Signal')=>({$delegate:true,$type:type,target,pointer:{$function:true,assembly:'EventUnit',method:{declaringType:'Targets',name,parameters:[],returnType:'System.Void',isStatic:target==null}}});
const service=(rt,name,left,right)=>invokeEventBuiltin(rt,ref(name,['System.Delegate','System.Delegate']),[left,right],null).value;
test('Remove searches the last complete contiguous sequence; RemoveAll removes all sequences without mutating its inputs',()=>{
 const rt=runtime(),a=delegate('A'),b=delegate('B'),c=delegate('C');
 const join=(x,y)=>service(rt,'Combine',x,y);
 const sequence=join(a,b),source=join(join(sequence,c),sequence);
 const removed=service(rt,'Remove',source,sequence);
 assert.deepEqual(removed.$invocationList,[a,b,c]);
 assert.deepEqual(source.$invocationList,[a,b,c,a,b]);
 assert.equal(service(rt,'RemoveAll',join(sequence,sequence),sequence),null);
 assert.equal(service(rt,'Remove',source,join(b,a)),source);
 assert.equal(service(rt,'RemoveAll',source,null),source);
 assert.equal(service(rt,'Remove',a,a),null);
 assert.equal(delegateEquals(join(a,b),join(delegate('A'),delegate('B'))),true);
 assert.equal(delegateEquals(join(a,b),join(b,a)),false);
 assert.equal(delegateEquals(a,delegate('A',null,'Other')),false);
});
test('Reference CompareExchange uses reference identity even for equal delegate values',()=>{
 const rt=runtime(),a=delegate('A'),equal=delegate('A'),next=delegate('B');let value=a;
 const address={$byref:true,get:()=>value,set:item=>{value=item;}};
 const method=ref('CompareExchange',['Signal&','Signal','Signal'],'Signal','System.Threading.Interlocked',true,{genericParameterCount:1,genericArguments:['Signal']});
 assert.equal(invokeEventBuiltin(rt,method,[address,next,equal],null).value,a);
 assert.equal(value,a);
 assert.equal(invokeEventBuiltin(rt,method,[address,next,a],null).value,a);
 assert.equal(value,next);
});
test('Event signature admission rejects wrong arity, byref, return type and unsupported scheduler calls',()=>{
 const valid=ref('CompareExchange',['System.Double&','System.Double','System.Double'],'System.Double','System.Threading.Interlocked');
 assert(eventBuiltin(valid));
 for(const changed of [{isStatic:false},{returnType:'System.Single'},{genericParameterCount:2},{parameters:['System.Double','System.Double','System.Double']},{parameters:['System.Double&','System.Double']}]) assert.equal(eventBuiltin({...valid,...changed}),null);
 for(const [type,name,p,r] of [['System.Threading.Thread','Sleep',['System.Int32'],'System.Void'],['System.Threading.Thread','Start',[],'System.Void'],['System.Threading.Interlocked','Add',['System.Single&','System.Single'],'System.Single'],['System.Delegate','DynamicInvoke',['System.Object[]'],'System.Object']]) assert.equal(isBuiltinCandidate(ref(name,p,r,type)),false);
 const invalidGeneric=ref('Exchange',['System.Decimal&','System.Decimal'],'System.Decimal','System.Threading.Interlocked',true,{genericParameterCount:1,genericArguments:['System.Decimal']});
 assert.equal(eventBuiltin(invalidGeneric),null);
});
test('Finite Delegate calls do not retain unrelated reflection and unsupported methods',()=>{
 const combine=ref('Combine',['System.Delegate','System.Delegate']);
 const model={name:'Selection',types:[{name:'Probe',methods:[{name:'Selected',token:1,declaringType:'Probe',parameters:[],isStatic:true,returnType:'System.Void',body:[{opcode:'call',operand:combine}]},{name:'Unrelated',token:2,declaringType:'Probe',parameters:[],isStatic:true,returnType:'System.Void',body:[]}]}]};
 const selected=selectJavaScriptExports(model,{exports:['Probe.Selected']});
 assert.equal(selected.selection.retainsAll,false);
 assert.equal(selected.selection.retainedMethods,1);
 assert.deepEqual(selected.model.types[0].methods.map(method=>method.name),['Selected']);
});

test('Virtual selection retains inheritance and interface implementations without selecting unrelated names',()=>{
 const method=(type,token,body=[])=>({name:'Run',token,declaringType:type,isStatic:false,returnType:'System.Int32',parameters:[],body});
 const model={name:'Hierarchy',types:[
  {name:'Entry',methods:[{name:'Main',token:1,declaringType:'Entry',isStatic:true,returnType:'System.Void',parameters:[],body:[{opcode:'callvirt',operand:ref('Run',[],'System.Int32','Base',false)},{opcode:'callvirt',operand:ref('Run',[],'System.Int32','IMarker',false)}]}]},
  {name:'Base',baseType:'System.Object',methods:[method('Base',2)]},
  {name:'Derived',baseType:'Base',methods:[method('Derived',3)]},
  {name:'IMarker',attributes:'Interface',methods:[{...method('IMarker',4),isAbstract:true}]},
  {name:'Implementation',baseType:'System.Object',interfaces:['IMarker'],methods:[method('Implementation',5)]},
  {name:'Unrelated',baseType:'System.Object',methods:[method('Unrelated',6)]},
 ]};
 const selected=selectJavaScriptExports(model,{exports:['Entry.Main']});
 assert.deepEqual(selected.model.types.flatMap(type=>type.methods).map(method=>method.token).sort(),[1,2,3,4,5]);
});
test('Comparer constructors and IReadOnlyList indexers require the admitted signatures',()=>{
 const dictionary='System.Collections.Generic.Dictionary`2<System.String,System.Int32>';
 const comparer='System.Collections.Generic.IEqualityComparer`1<System.String>';
 assert(isBuiltinCandidate(ref('.ctor',[comparer],'System.Void',dictionary,false)));
 assert(isBuiltinCandidate(ref('.ctor',['System.Int32',comparer],'System.Void',dictionary,false)));
 assert.equal(isBuiltinCandidate(ref('.ctor',['System.Collections.Generic.IComparer`1<System.String>'],'System.Void',dictionary,false)),false);
 assert.equal(isBuiltinCandidate(ref('.ctor',[comparer],'System.Int32',dictionary,false)),false);
 const indexer=ref('get_Item',['System.Int32'],'!0','System.Collections.Generic.IReadOnlyList`1<System.Byte[]>',false);
 assert(isBuiltinCandidate(indexer));
 assert.equal(isBuiltinCandidate({...indexer,returnType:'System.Int32'}),false);
 assert.equal(isBuiltinCandidate({...indexer,isStatic:true}),false);
});
