import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {decimalAdd,decimalMultiply,decimalDivide,decimalRemainder,decimalRound,parseDecimal,formatDecimal,invokeStandardValueBuiltin,isStandardValueBuiltin,isStandardValueField} from '../src/il/standard-values.mjs';
import {i4,i8,r4,r8,createRuntime} from '../src/il/runtime.mjs';
const baseline=JSON.parse(await readFile(new URL('./standard-values-native-baseline.json',import.meta.url)));
function execute(input){
  const {op}=input;
  const a=['double','single'].includes(op)?null:parseDecimal(input.a,input.styles),b=input.b===undefined?null:parseDecimal(input.b);
  let v;
  if(op==='add')v=decimalAdd(a,b);else if(op==='subtract')v=decimalAdd(a,b,true);else if(op==='multiply')v=decimalMultiply(a,b);else if(op==='divide')v=decimalDivide(a,b);else if(op==='remainder')v=decimalRemainder(a,b);else if(op==='round')v=decimalRound(a,input.digits,input.mode);else if(op==='double'||op==='single')v=invokeStandardValueBuiltin(null,{declaringType:'System.Decimal',name:'.ctor',parameters:[{type:op==='double'?'System.Double':'System.Single'}]},[op==='double'?r8(Number(input.a)):r4(Number(input.a))],null,'newobj').constructed;else v=a;
  if(op==='format')return {text:formatDecimal(v,input.format)};
  if(op==='toDouble'||op==='toSingle'){
    const result=invokeStandardValueBuiltin(null,{declaringType:'System.Decimal',name:op==='toDouble'?'ToDouble':'ToSingle',returnType:op==='toDouble'?'System.Double':'System.Single',parameters:[{type:'System.Decimal'}]},[v]).value.value;
    const view=new DataView(new ArrayBuffer(8));if(op==='toDouble'){view.setFloat64(0,result,true);return{binaryBits:view.getBigInt64(0,true).toString()};}view.setFloat32(0,result,true);return{binaryBits:view.getInt32(0,true).toString()};
  }
  return{text:formatDecimal(v),bits:[Number(v.coefficient&0xffffffffn)|0,Number(v.coefficient>>32n&0xffffffffn)|0,Number(v.coefficient>>64n)|0,v.scale<<16|(v.negative?0x80000000:0)]};
}
for(const[item,index]of baseline.cases.map((v,i)=>[v,i]))test(`exact native Decimal oracle ${index+1}: ${item.input.op} ${item.input.a}`,()=>{
  if(item.result.exception)assert.throws(()=>execute(item.input),e=>e.$type===item.result.exception);
  else assert.deepEqual(execute(item.input),item.result);
});
test('Decimal classifiers reject unsupported spans, providers and generic math overloads',()=>{
  const ref=(name,p)=>({declaringType:'System.Decimal',name,parameters:p.map(type=>({type}))});
  assert.equal(isStandardValueBuiltin(ref('TryParse',['System.ReadOnlySpan`1<System.Char>','System.Decimal&'])),false);
  assert.equal(isStandardValueBuiltin(ref('CreateSaturating',['!!0'])),false);
  assert.equal(isStandardValueField({declaringType:'System.Decimal',name:'privateState'}),false);
  assert.throws(()=>formatDecimal(parseDecimal('1.5'),'C2'),e=>e.runtimeLimitation);
  assert.throws(()=>parseDecimal('$1.5',383),e=>e.runtimeLimitation);
});
test('standard value defaults, nested copies and nullable boxing retain CLR semantics',()=>{
  const rt=createRuntime({name:'Values',types:[]}),name='System.Nullable`1<System.Decimal>',n=rt.defaultValue(name);
  assert.equal(rt.box(n,name),null);assert.equal(rt.unbox(null,name,true).fields[name+'::hasValue'].value,0);
  const tup='System.ValueTuple`2<System.Decimal,System.Int32>',value=rt.defaultValue(tup),copy=rt.copy(value);copy.fields[tup+'::Item1'].coefficient=123n;
  assert.equal(value.fields[tup+'::Item1'].coefficient,0n);
});
test('nullable equality retains boxed underlying type identity and floating hashes are supported',()=>{
  const rt=createRuntime({name:'Values',types:[]}),type='System.Nullable`1<System.Int32>';
  const value=invokeStandardValueBuiltin(rt,{declaringType:type,name:'.ctor',parameters:[{type:'System.Int32'}]},[i4(42)],null,'newobj').constructed;
  const ref={declaringType:type,name:'Equals',parameters:[{type:'System.Object'}]};
  assert.equal(invokeStandardValueBuiltin(rt,ref,[rt.box(i4(42),'System.Int32')],value).value.value,1);
  assert.equal(invokeStandardValueBuiltin(rt,ref,[rt.box(i8(42),'System.Int64')],value).value.value,0);
  assert.equal(isStandardValueBuiltin({declaringType:'System.Nullable`1<System.Double>',name:'GetHashCode',parameters:[]}),true);
});
