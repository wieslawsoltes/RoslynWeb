import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/browser.js';
import {NodeBrowserWorker} from './worker-adapter.mjs';
import {compatibilityExamples} from '../demo/compatibility-workflows.js';
const previous=globalThis.Worker; globalThis.Worker=NodeBrowserWorker;
const tests=[]; let compiler;
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r.error||r.diagnostics));return r;};
const text=bytes=>new TextDecoder().decode(bytes);
async function test(name,fn){try{await fn();tests.push({name,passed:true});console.log('PASS',name);}catch(error){tests.push({name,passed:false,error:error.stack});console.error('FAIL',name,error);}}
try {
 compiler=await createRoslyn({baseUrl:new URL('../dist/',import.meta.url),timeoutMs:60000});
 let io;
 await test('Demo C# builds a dynamic CLR type and invokes generated JavaScript',async()=>{
  const c=ok(await compiler.compile(compatibilityExamples.find(x=>x.kind==='type-builder').source));
  assert.equal(ok(await compiler.run(c,{backend:'javascript'})).stdout.trim(),'42');
 });
 await test('Real C# System.IO inputs, binary outputs and snapshots cross the Worker API',async()=>{
  io=ok(await compiler.compile('using System;using System.IO;Console.WriteLine(File.ReadAllText("input.txt"));File.WriteAllBytes("output.bin",new byte[]{0,128,255});File.Delete("old.txt");'));
  const r=ok(await compiler.run(io,{virtualFiles:{'work/input.txt':'π from JavaScript','work/old.txt':'old'},workingDirectory:'work',captureVirtualFiles:true}));
  assert.equal(r.stdout.trim(),'π from JavaScript');assert.deepEqual(r.virtualFiles['work/output.bin'],new Uint8Array([0,128,255]));
  assert.deepEqual(r.removedFiles,['work/old.txt']);assert.ok(r.changedFiles['work/output.bin']);
 });
 await test('Automatic WASM fallback retains files for a real framework-dependent program',async()=>{
  const c=ok(await compiler.compile('using System;using System.IO;using System.Text.Json;Console.WriteLine(JsonDocument.Parse(File.ReadAllText("input.json")).RootElement.GetProperty("value").GetInt32());'));
  const r=ok(await compiler.run(c,{backend:'auto',virtualFiles:{'input.json':'{"value":42}'}}));assert.equal(r.stdout.trim(),'42');
  // JsonDocument requires real CLR framework behavior in the current JS surface.
  assert.equal(r.backend,'wasm');assert.equal(r.fallback.supported,false);
 });
 await test('Persistent workspaces preserve managed file state across generic invocations and API edits',async()=>{
  const c=ok(await compiler.compile('using System.IO;public static class Files {public static T Write<T>(T value){File.WriteAllText("value.txt",value!.ToString());return value;}public static string Read()=>File.ReadAllText("value.txt");}',{outputKind:'library'}));
  const ws=await compiler.createWorkspace({files:{'value.txt':'initial','bytes.bin':[0,255,17]},maxFileBytes:1024});
  try {
   assert.deepEqual(ws.files['bytes.bin'],new Uint8Array([0,255,17]));assert.equal(ws.maxFileBytes,1024);
   const r=ok(await compiler.invoke(c.assemblyId,'Files','Write',[42],{workspaceId:ws.workspaceId,genericArguments:['int'],parameterTypes:['int']}));assert.equal(r.result,42);assert.equal(text(r.files['value.txt']),'42');
   assert.equal(text((await compiler.readWorkspace(ws.workspaceId,['value.txt'])).files['value.txt']),'42');
   await compiler.writeWorkspace(ws.workspaceId,{'extra.txt':'extra'});
   assert.deepEqual((await compiler.listWorkspace(ws.workspaceId)).entries.map(x=>x.path).sort(),['bytes.bin','extra.txt','value.txt']);
   await compiler.deleteWorkspaceFiles(ws.workspaceId,['extra.txt']);
   assert.equal((await compiler.listWorkspace(ws.workspaceId)).entries.length,2);
   const run=ok(await compiler.compile('using System;using System.IO;Console.WriteLine(File.ReadAllText("value.txt"));'));
   assert.equal(ok(await compiler.run(run,{backend:'auto',workspaceId:ws.workspaceId})).stdout.trim(),'42');
  } finally { await compiler.disposeWorkspace(ws.workspaceId); }
  await assert.rejects(compiler.readWorkspace(ws.workspaceId));
 });
 await test('Managed file changes survive a structured C# exception',async()=>{
  const c=ok(await compiler.compile('using System;using System.IO;File.WriteAllText("before-error.txt","saved");throw new Exception("expected");'));
  const r=await compiler.run(c,{captureVirtualFiles:true});assert.equal(r.success,false);assert.match(r.error.message,/expected/);assert.equal(text(r.virtualFiles['before-error.txt']),'saved');
 });
 await test('Real native WASI command registers and executes through compiler Worker RPC',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../tests/fixtures/wasi-command.json',import.meta.url),'utf8'));
  const registration=await compiler.addNativeCommand('generator',new Uint8Array(Buffer.from(fixture.base64,'base64')));
  assert.equal(registration.name,'generator');assert.ok(registration.imports.includes('fd_write'));
  const r=ok(await compiler.runNativeCommand('generator',{args:['generate','input.txt','Generated.cs'],env:{OFFSET:'2'},files:{'/input.txt':'40'}}));
  assert.match(text(r.files['/Generated.cs']),/Value => 42/);
  const c=ok(await compiler.compile([{path:'Generated.cs',text:text(r.files['/Generated.cs'])},{path:'Program.cs',text:'using System;Console.WriteLine(NativeGenerated.Value);'}]));
  assert.equal(ok(await compiler.run(c)).stdout.trim(),'42');
  assert.equal(await compiler.removeNativeCommand('generator'),true);await assert.rejects(compiler.runNativeCommand('generator'));
 });
 await test('Native execution pre-abort leaves a usable compiler and starts no native program',async()=>{
  const controller=new AbortController();controller.abort();await assert.rejects(compiler.runNativeCommand('missing',{signal:controller.signal}));
  assert.equal(compiler.disposed,false);assert.ok((await compiler.references()).length>=160);
 });
 await test('A real infinite native WASI loop is terminated by its Worker deadline',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../tests/fixtures/wasi-command.json',import.meta.url),'utf8'));
  await compiler.addNativeCommand('loop',new Uint8Array(Buffer.from(fixture.base64,'base64')));
  await assert.rejects(compiler.runNativeCommand('loop',{args:['spin'],timeoutMs:100}),error=>error.code==='TIMEOUT');
  assert.equal(compiler.disposed,true);await assert.rejects(compiler.references(),error=>error.code==='DISPOSED');
 });
} catch(error){tests.push({name:'startup',passed:false,error:error.stack});console.error(error);}
finally {
 compiler?.dispose();for(const worker of NodeBrowserWorker.instances)worker.terminate();await Promise.all(NodeBrowserWorker.instances.map(w=>w.termination));
 if(previous===undefined)delete globalThis.Worker;else globalThis.Worker=previous;
 const report={testedAt:new Date().toISOString(),environment:'Actual .NET browser WASM, native WASI and Worker public API under Node',passed:tests.filter(x=>x.passed).length,failed:tests.filter(x=>!x.passed).length,tests};
 await writeFile(new URL('../docs/v4-api-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(`${report.passed} passed; ${report.failed} failed`);process.exitCode=report.failed?1:0;
}
