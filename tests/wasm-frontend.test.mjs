import test from 'node:test';
import assert from 'node:assert/strict';
import {compileWasm,loadWasm} from '../src/wasm/index.js';

const ins=(offset,opcode,operand)=>({offset,opcode,operand,size:1});
const model=(body,{result='System.Double',parameters=[]}={})=>({name:'TypedStackFixture',types:[{name:'Kernel',fields:[],methods:[{name:'Run',declaringType:'Kernel',token:0x06000001,isStatic:true,attributes:'Public, Static',returnType:result,parameters:parameters.map(type=>({type})),locals:[],body}]}]});
async function execute(body,settings,args,expected){
  for(const optimize of [false,true]){
    const artifact=compileWasm(model(body,settings),{optimize});
    assert.equal(WebAssembly.validate(artifact.bytes),true);assert.deepEqual(artifact.imports,[]);
    const program=await loadWasm(artifact);try{assert.equal(program.invoke('Run',args),expected);}finally{program.dispose();}
  }
}

test('mixed native F stack arithmetic widens operands without runtime imports',async()=>{
  for(const [op,a,b,expected]of [['add',1.25,2.5,3.75],['sub',1.25,2.5,-1.25],['mul',1.25,2.5,3.125],['div',1.25,2.5,0.5],['rem',7.25,2.5,2.25]]){
    await execute([ins(0,'ldc.r4',a),ins(1,'ldc.r8',b),ins(2,op),ins(3,'ret')],{},[],expected);
    await execute([ins(0,'ldc.r8',a),ins(1,'ldc.r4',b),ins(2,op),ins(3,'ret')],{},[],expected);
  }
});

test('mixed floating comparisons retain NaN unordered and signed-zero semantics',async()=>{
  for(const [op,a,b,expected]of [['ceq',-0,0,1],['ceq',NaN,2,0],['cgt.un',NaN,2,1],['clt.un',1,NaN,1],['clt',NaN,1,0]])
    await execute([ins(0,'ldc.r4',a),ins(1,'ldc.r8',b),ins(2,op),ins(3,'ret')],{result:'System.Int32'},[],expected);
});

test('native float CFG merges promote branch results on both layouts',async()=>{
  const body=[ins(0,'ldarg.0'),ins(1,'brtrue',5),ins(2,'ldc.r4',1.25),ins(3,'br',7),ins(4,'nop'),ins(5,'ldc.r8',2.5),ins(6,'br',7),ins(7,'ldc.r4',4),ins(8,'add'),ins(9,'ret')];
  await execute(body,{parameters:['System.Boolean']},[false],5.25);
  await execute(body,{parameters:['System.Boolean']},[true],6.5);
});

test('conditional and switch edges preserve a lower floating stack value',async()=>{
  const branch=[ins(0,'ldc.r4',1.25),ins(1,'ldarg.0'),ins(2,'brtrue',5),ins(3,'conv.r8'),ins(4,'br',6),ins(5,'br',6),ins(6,'ldc.r8',2.5),ins(7,'add'),ins(8,'ret')];
  await execute(branch,{parameters:['System.Boolean']},[false],3.75);
  await execute(branch,{parameters:['System.Boolean']},[true],3.75);
  const choice=[ins(0,'ldc.r4',1.25),ins(1,'ldarg.0'),ins(2,'switch',[5,7]),ins(3,'conv.r8'),ins(4,'br',9),ins(5,'conv.r8'),ins(6,'br',9),ins(7,'nop'),ins(8,'br',9),ins(9,'ldc.r8',2.5),ins(10,'add'),ins(11,'ret')];
  for(const index of [-1,0,1,2])await execute(choice,{parameters:['System.Int32']},[index],3.75);
});

test('actual C# standard-value exports accept precise plain JavaScript arguments',async()=>{
  const {readFile}=await import('node:fs/promises');
  const fixture=JSON.parse(await readFile(new URL('./compiler-v6-fixture.json',import.meta.url)));
  for(const optimize of [false,true]){
    const artifact=compileWasm(fixture,{exports:['DecimalIdentity','NullableIdentity','TupleIdentity'],optimize});
    const program=await loadWasm(artifact);
    try{
      assert.equal(program.invoke('DecimalIdentity',['79228162514264337593543950335']),'79228162514264337593543950335');
      assert.equal(program.invoke('DecimalIdentity',['0.1000000000000000000000000000']),'0.1000000000000000000000000000');
      assert.equal(program.invoke('DecimalIdentity',[9007199254740993n]),'9007199254740993');
      assert.equal(program.invoke('NullableIdentity',[null]),null);
      assert.equal(program.invoke('NullableIdentity',[42]),42);
      assert.deepEqual(program.invoke('TupleIdentity',[[7,'1.2300']]),[7,'1.2300']);
      assert.deepEqual(program.invoke('TupleIdentity',[{Item1:9,Item2:'9007199254740993'}]),[9,'9007199254740993']);
      assert.throws(()=>program.invoke('TupleIdentity',[[7]]),/tuple|arity|length|exact|2/i);
    }finally{program.dispose();}
  }
});
