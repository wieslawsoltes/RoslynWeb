import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {basename,dirname,join,resolve} from 'node:path';

test('download server serves the demo and ES modules and rejects traversal', {timeout:15000}, async t => {
  const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
  const outside=await mkdtemp(join(dirname(root),'roslynweb-server-test-'));
  await writeFile(join(outside,'outside.txt'),'outside-workspace-sentinel');
  t.after(()=>rm(outside,{recursive:true,force:true}));
  const child=spawn(process.execPath,[join(root,'scripts/serve.mjs')],{
    cwd:root,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']
  });
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  });
  const address=await new Promise((resolve,reject)=>{
    let output='';
    child.on('error',reject);
    child.on('exit',code=>reject(new Error(`Server exited before listening: ${code}`)));
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(match)resolve(`http://127.0.0.1:${match[1]}`);});
    child.stderr.on('data',chunk=>reject(new Error(String(chunk))));
  });
  for(const path of ['/','/demo/','/src/browser.js']){
    const response=await fetch(address+path);
    assert.equal(response.status,200,path);
    const body=await response.text();assert.ok(body.length>100,path);
    assert.match(response.headers.get('content-type'),path.endsWith('.js')?/javascript/:/text\/html/);
  }
  for(const path of ['/missing-file-roslynweb','/..%2f'+basename(outside)+'/outside.txt']){
    const response=await fetch(address+path);assert.equal(response.status,404,path);assert.equal(await response.text(),'Not found');
  }
});
