import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildExceptionPlan,createExceptionContext,createExceptionFrame,positionExceptionFrame,exitExceptionFrame,dispatchException,finishFinally,leaveProtectedRegion,caughtException} from '../src/wasm/exceptions.mjs';
const body=Array.from({length:100},(_,offset)=>({offset,size:1,opcode:'nop'}));
const clause=(kind,tryOffset,tryLength,handlerOffset,handlerLength,extra={})=>({kind,tryOffset,tryLength,handlerOffset,handlerLength,...extra});
const makePlan=handlers=>buildExceptionPlan({body,exceptionHandlers:handlers});
const error=message=>Object.assign(new Error(message),{$type:'System.Exception'});
const filter=clause('filter',0,10,20,10,{filterOffset:10});
const finallyClause=clause('finally',0,10,10,10);
function propagate(frame,origin,pending){try{dispatchException(frame,origin,pending);}catch(error){return error;}throw Error('Expected escaping exception');}

test('first-pass caller filters execute before callee finally and catch receives original identity',()=>{
 const trace=[];const context=createExceptionContext({evaluateFilter(frame,handler,e){trace.push('filter');assert.equal(e,original);return true;}});
 const caller=createExceptionFrame(makePlan([filter]),{context});positionExceptionFrame(caller,3);
 const callee=createExceptionFrame(makePlan([finallyClause]),{context}),original=error('original');
 assert.equal(dispatchException(callee,2,original),10);assert.deepEqual(trace,['filter']);
 trace.push('finally');let completed;try{finishFinally(callee);}catch(e){completed=e;}
 const pending=propagate(callee,15,completed);assert.equal(context.frames.length,1);
 assert.equal(dispatchException(caller,3,pending),20);assert.equal(caughtException(caller),original);
 trace.push('catch');assert.deepEqual(trace,['filter','finally','catch']);exitExceptionFrame(caller);assert.equal(context.frames.length,0);
});

test('filter exceptions are false, side effects survive and later candidates see original error',()=>{
 const original=error('original'),trace=[];
 const context=createExceptionContext({evaluateFilter(frame,handler,e){assert.equal(e,original);trace.push(handler.order);if(handler.order===0)throw error('filter failure');return true;}});
 const frame=createExceptionFrame(makePlan([filter,clause('filter',0,10,40,10,{filterOffset:30})]),{context});
 assert.equal(dispatchException(frame,1,original),40);assert.deepEqual(trace,[0,1]);assert.equal(caughtException(frame),original);
});

test('an exception thrown in a filter helper searches only frames inside that filter',()=>{
 const trace=[],original=error('original');let nested;
 const context=createExceptionContext({evaluateFilter(frame,handler,e){
   trace.push('filter');nested=createExceptionFrame(makePlan([finallyClause]),{context});
   assert.equal(dispatchException(nested,2,error('nested')),10);trace.push('filter helper finally');
   let completed;try{finishFinally(nested);}catch(value){completed=value;}
   throw propagate(nested,15,completed);
 }});
 const outer=createExceptionFrame(makePlan([filter,clause('catch',0,10,40,10,{catchType:'System.Exception'})]),{context});
 assert.equal(dispatchException(outer,2,original),40);assert.deepEqual(trace,['filter','filter helper finally']);assert.equal(caughtException(outer),original);assert.deepEqual(context.frames,[outer]);
});

test('replacement exceptions from finally begin a new search and rerun outer filters',()=>{
 const seen=[];const context=createExceptionContext({evaluateFilter(frame,handler,e){seen.push(e.message);return true;}});
 const caller=createExceptionFrame(makePlan([filter]),{context});positionExceptionFrame(caller,1);
 const callee=createExceptionFrame(makePlan([finallyClause]),{context});
 assert.equal(dispatchException(callee,1,error('first')),10);
 const second=error('second'),pending=propagate(callee,15,second);
 assert.equal(dispatchException(caller,1,pending),20);assert.equal(caughtException(caller),second);assert.deepEqual(seen,['first','second']);
});

test('catch before outer filter ends the search pass without evaluating the filter',()=>{
 const context=createExceptionContext({evaluateFilter(){assert.fail('Outer filter must not execute');}});
 const caller=createExceptionFrame(makePlan([filter]),{context});positionExceptionFrame(caller,1);
 const callee=createExceptionFrame(makePlan([clause('catch',0,10,10,10,{catchType:'System.Exception'})]),{context});
 assert.equal(dispatchException(callee,2,error('handled')),10);assert.equal(leaveProtectedRegion(callee,15,25),25);exitExceptionFrame(callee);assert.deepEqual(context.frames,[caller]);
});

test('fatal host failures inside filter evaluation escape instead of becoming false',()=>{
 const fatal=Object.assign(new Error('instruction limit'),{code:'WASM_INSTRUCTION_LIMIT'});
 const context=createExceptionContext({evaluateFilter(){throw fatal;}}),frame=createExceptionFrame(makePlan([filter,clause('catch',0,10,40,10,{catchType:'System.Exception'})]),{context});
 assert.throws(()=>dispatchException(frame,1,error('original')),error=>error===fatal);
 assert.deepEqual(context.filterBoundaries,[]);
});
