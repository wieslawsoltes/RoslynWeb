import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateModule} from '../src/il/compiler.mjs';
test('saved JavaScript modules need only the documented standalone IL runtime directory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roslynweb-standalone-js-'));
 try {
  await cp(new URL('../src/il/',import.meta.url),join(dir,'il'),{recursive:true});
  const model={name:'Portable',entryPoint:1,types:[{name:'Program',methods:[{token:1,name:'Main',isStatic:true,returnType:'System.Int32',parameters:[],body:[{offset:0,opcode:'ldc.i4',operand:42},{offset:1,opcode:'ret'}]}]}]};
  await writeFile(join(dir,'program.mjs'),generateModule(model,{runtimeImport:'./il/runtime.mjs'}));
  await writeFile(join(dir,'check.mjs'),"globalThis.Function=function(){throw new Error('Dynamic code prohibited');}; const {createAssembly}=await import('./program.mjs'); if(await createAssembly().run([])!==42)throw new Error('Wrong result');");
  const result=spawnSync(process.execPath,[join(dir,'check.mjs')],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
 }finally{await rm(dir,{recursive:true,force:true});}
});
