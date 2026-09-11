import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileWasm} from '../src/wasm/compiler.mjs';
import {loadWasm} from '../src/wasm/runtime.mjs';
import {planStructuredControlFlow} from '../src/wasm/optimizer.mjs';
import {decodeNativeValue} from './wasm-native-values.mjs';
const model=JSON.parse(await readFile(new URL('./wasm-native-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./wasm-native-baseline.json',import.meta.url)));

for(const name of ['Loop','Fibonacci','Switch','ArrayLoop']) {
  test(`${name} removes dispatch while preserving real Roslyn IL and instruction fuel`,async()=>{
    const artifacts=[false,true].map(optimize=>compileWasm(model,{exports:[name],optimize}));
    assert.equal(artifacts[0].optimization.enabled,false);
    assert.equal(artifacts[1].optimization.structuredMethods,1);
    assert.equal(artifacts[1].optimization.dispatcherMethods,0);
    assert.ok(artifacts[1].optimization.eliminatedDispatches>0);
    assert.ok(artifacts[1].optimization.functionBodyBytes<artifacts[0].optimization.functionBodyBytes);
    const programs=await Promise.all(artifacts.map(loadWasm));
    try {
      for(const item of baseline.cases.filter(item=>item.method===name&&!item.exception)){
        const args=item.arguments.map(decodeNativeValue), expected=decodeNativeValue(item.result);
        for(const program of programs)assert.equal(program.invoke(name,args),expected);
        assert.equal(programs[0].exports.__fuel.value,programs[1].exports.__fuel.value);
      }
    } finally {for(const program of programs)program.dispose();}
  });
}

test('optimizer baseline preserves every existing real .NET arithmetic, conversion and exception oracle',async()=>{
  const programs=new Map();
  try {
    for(const item of baseline.cases){
      if(!programs.has(item.method))programs.set(item.method,await loadWasm(compileWasm(model,{exports:[item.method,...(item.method==='ReflectedCall'?['Add']:[])],optimize:false})));
      const program=programs.get(item.method),args=item.arguments.map(decodeNativeValue);
      if(item.exception)assert.throws(()=>program.invoke(item.method,args),error=>(error.type??error.managedType??error.$type)===item.exception,item.method);
      else assert.equal(program.invoke(item.method,args),decodeNativeValue(item.result),item.method);
    }
  }finally{for(const program of programs.values())program.dispose();}
});

test('structured native loops and dispatcher baseline trap at exactly the same budget',async()=>{
  const artifacts=[false,true].map(optimize=>compileWasm(model,{exports:['Loop'],optimize}));
  for(const budget of[1,5,6,20,37,100,1000]){
    const programs=await Promise.all(artifacts.map(artifact=>loadWasm(artifact,{maxInstructions:budget})));
    try{
      for(const program of programs)assert.throws(()=>program.invoke('Loop',[10000]),error=>error.code==='WASM_INSTRUCTION_LIMIT');
      assert.equal(programs[0].exports.__fuel.value,programs[1].exports.__fuel.value);
    }finally{for(const program of programs)program.dispose();}
  }
});

const cfg=successors=>successors.map((targets,offset)=>({offset,successors:targets,instructions:[]}));
test('control-flow planner rejects irreducible entries and unreachable blocks',()=>{
  assert.equal(planStructuredControlFlow(cfg([[1,2],[2],[1,3],[]])),null);
  assert.equal(planStructuredControlFlow(cfg([[],[]])),null);
});
test('control-flow planner forms nested loops without duplicating blocks',()=>{
  const graph=cfg([[1],[2,5],[3,4],[2],[1],[]]),plan=planStructuredControlFlow(graph);
  assert.ok(plan);assert.equal(plan.loops.size,2);
  assert.deepEqual(new Set(plan.blocks.map(block=>block.offset)),new Set(graph.map(block=>block.offset)));
  assert.equal(plan.blocks.length,graph.length);
});
