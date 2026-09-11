// Real CLI subprocesses retain the production Roslyn Worker across watch edits.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rename,readFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const binary=fileURLToPath(new URL('../bin/roslynweb.mjs',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'roslynweb-watch-'));
const children=new Set(),checks=[];
const started=performance.now();
const watchdog=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exitCode=1;},180000);

async function edit(path,text) {
  const next=path+'.next';await writeFile(next,text);await rename(next,path);
}
function launch(args,cwd=temporary) {
  const child=spawn(process.execPath,[binary,'watch',...args,'--json','--verbose','--poll-ms','50'],{cwd,stdio:['ignore','pipe','pipe']});
  children.add(child);
  const state={child,lines:[],stderr:'',pending:'',waiters:[],closed:false,error:null};
  const pump=()=>{
    for(const waiter of [...state.waiters]) {
      const result=state.lines[waiter.index];
      if(result || state.closed || state.error) {
        state.waiters.splice(state.waiters.indexOf(waiter),1);clearTimeout(waiter.timer);
        if(result)waiter.resolve(result);else waiter.reject(state.error || new Error(`Watch closed before result ${waiter.index+1}: ${state.stderr}`));
      }
    }
  };
  child.stdout.on('data',chunk=>{
    state.pending+=chunk;
    let newline;
    while((newline=state.pending.indexOf('\n'))>=0) {
      const text=state.pending.slice(0,newline);state.pending=state.pending.slice(newline+1);
      if(!text.trim())continue;
      try{state.lines.push(JSON.parse(text));}catch(error){state.error=new Error(`Watch stdout must be JSON lines: ${text.slice(0,500)}`,{cause:error});}
      pump();
    }
  });
  child.stderr.on('data',chunk=>{state.stderr+=chunk;});
  state.completion=new Promise(resolve=>{
    child.on('error',error=>{state.error=error;pump();});
    child.on('close',(code,signal)=>{children.delete(child);state.closed=true;pump();resolve({code,signal});});
  });
  state.result=index=>new Promise((resolve,reject)=>{
    const waiter={index,resolve,reject};
    waiter.timer=setTimeout(()=>{state.waiters.splice(state.waiters.indexOf(waiter),1);reject(new Error(`Watch result ${index+1} timed out. ${state.stderr}`));},90000);
    state.waiters.push(waiter);pump();
  });
  state.stop=async()=>{
    child.kill('SIGINT');
    const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{const result=await state.completion;assert.equal(result.code,130,JSON.stringify(result)+' '+state.stderr);assert.equal(result.signal,null);return result;}
    finally{clearTimeout(deadline);}
  };
  return state;
}
async function check(name,action) {
  const begin=performance.now();
  try {const evidence=await action();checks.push({name,passed:true,milliseconds:performance.now()-begin,evidence});console.log('PASS',name);}
  catch(error){checks.push({name,passed:false,error:{message:error.message,stack:error.stack}});throw error;}
}

let runWatch,compileWatch;
try {
  const source=join(temporary,'Hello.cs');
  await edit(source,'System.Console.WriteLine("watch-v1");');
  runWatch=launch(['run','Hello.cs','--backend','javascript']);
  await check('Watch run executes edits in one persistent Roslyn Worker',async()=>{
    const first=await runWatch.result(0);
    assert.equal(first.success,true,JSON.stringify(first));assert.equal(first.iteration,1);assert.equal(first.stdout.trim(),'watch-v1');
    await edit(source,'System.Console.WriteLine("watch-v2");');
    const second=await runWatch.result(1);
    assert.equal(second.success,true,JSON.stringify(second));assert.equal(second.iteration,2);assert.equal(second.stdout.trim(),'watch-v2');
    assert.deepEqual(second.changed,[source]);
    assert.equal((runWatch.stderr.match(/\[ready\]/g)||[]).length,1,'source edits must retain the compiler and its caches');
    return {iterations:[first.iteration,second.iteration],outputs:[first.stdout.trim(),second.stdout.trim()],compilerStartups:1};
  });
  await check('Watch reports C# errors, recovers on the next edit and exits cleanly on SIGINT',async()=>{
    await edit(source,'System.Console.WriteLine(;');
    const invalid=await runWatch.result(2);
    assert.equal(invalid.success,false);assert.equal(invalid.iteration,3);
    assert(invalid.diagnostics.some(diagnostic=>diagnostic.severity==='error' && /^CS\d+$/.test(diagnostic.id)));
    await edit(source,'System.Console.WriteLine("watch-recovered");');
    const fixed=await runWatch.result(3);
    assert.equal(fixed.success,true,JSON.stringify(fixed));assert.equal(fixed.iteration,4);assert.equal(fixed.stdout.trim(),'watch-recovered');
    await delay(350);
    assert.equal(runWatch.lines.length,4,'each edit must execute exactly once');
    assert.equal((runWatch.stderr.match(/\[ready\]/g)||[]).length,1);
    const exit=await runWatch.stop();
    return {iterations:runWatch.lines.map(result=>result.iteration),diagnostics:invalid.diagnostics.map(d=>d.id),recoveredOutput:fixed.stdout.trim(),exitCode:exit.code};
  });
  await check('Watch compile ignores its default DLL output and rebuilds only when source changes',async()=>{
    const directory=join(temporary,'compile');await mkdir(directory);
    const program=join(directory,'Program.cs');await edit(program,'System.Console.WriteLine("compile-v1");');
    compileWatch=launch(['compile','.'],directory);
    const first=await compileWatch.result(0);
    assert.equal(first.success,true,JSON.stringify(first));assert.equal(first.iteration,1);
    const output=first.outputs.output;
    assert.equal(output,join(directory,'Program.dll'));
    const initial=await readFile(output);assert.equal(initial[0],77);assert.equal(initial[1],90);
    await delay(550);
    assert.equal(compileWatch.lines.length,1,'creating the default DLL must not trigger an extra compilation');
    await edit(program,'System.Console.WriteLine("compile-v2");');
    const second=await compileWatch.result(1);
    assert.equal(second.success,true,JSON.stringify(second));assert.equal(second.iteration,2);
    assert.deepEqual(second.changed,[program]);
    assert.equal(second.performance.cache.compilationReused,true);
    const updated=await readFile(output);assert.notDeepEqual(updated,initial);
    await delay(550);
    assert.equal(compileWatch.lines.length,2,'replacement DLL output must remain ignored');
    assert.equal((compileWatch.stderr.match(/\[ready\]/g)||[]).length,1);
    const exit=await compileWatch.stop();
    return {iterations:[first.iteration,second.iteration],defaultOutput:'Program.dll',compilerStartups:1,cache:second.performance.cache,exitCode:exit.code};
  });
}catch(error){console.error(error);process.exitCode=1;}
finally {
  clearTimeout(watchdog);
  for(const child of children)child.kill('SIGKILL');
  await Promise.all([runWatch?.completion,compileWatch?.completion]);
  await rm(temporary,{recursive:true,force:true});
  await writeFile(new URL('../docs/cli-watch-verification.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),runtime:process.version,passed:checks.every(check=>check.passed),elapsedMilliseconds:performance.now()-started,checks},null,2)+'\n');
  console.log(`${checks.filter(check=>check.passed).length}/${checks.length} CLI watch integration checks passed`);
}
