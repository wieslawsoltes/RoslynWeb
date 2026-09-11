import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {dotnet} from '../dist/_framework/dotnet.js';
const runtime=await dotnet.withDiagnosticTracing(false).create();
const bridge=(await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName)).RoslynBrowser.CompilerBridge;
const records=[];
async function test(name,action){const t=performance.now();try{await action();records.push({name,status:'passed',ms:Math.round(performance.now()-t)});console.log('PASS',name);}catch(error){records.push({name,status:'failed',message:error.message,stack:error.stack});console.error('FAIL',name,error.stack);}}
const json=JSON.stringify;
const parsed=async promise=>JSON.parse(await promise);
const compile=async(source,options={})=>{const r=await parsed(bridge.CompileAsync(json({source,compilerExtensions:[],...options})));assert.equal(r.success,true,json(r));return r.assemblyId;};
const file=(path,value)=>({path,base64:Buffer.from(value).toString('base64')});
const text=(result,path,field='files')=>Buffer.from(result[field].find(f=>f.path===path)?.base64??'','base64').toString();
const run=(assembly,request={})=>parsed(bridge.RunWithFiles(assembly,'[]',json(request)));
const invoke=(assembly,type,method,args=[],request={})=>parsed(bridge.InvokeWithFiles(assembly,type,method,json(args),json(request)));
const workspace=request=>parsed(bridge.WorkspaceFiles(json(request)));
let program,library,id,output;
await test('Compile actual C# async System.IO program',async()=>{
 program=await compile('using System;using System.IO;using System.Threading.Tasks;await Task.Yield();Directory.CreateDirectory("out");File.WriteAllText("out/result.txt",File.ReadAllText("input.txt")+"42");File.Delete("delete.txt");Console.WriteLine(File.ReadAllText("out/result.txt"));return 7;');
});
await test('Seed actual .NET WASM files, run C# and capture binary snapshots',async()=>{
 output=await run(program,{files:[file('app/input.txt','value='),file('app/delete.txt','remove')],workingDirectory:'app'});
 assert.equal(output.success,true,json(output));assert.equal(output.exitCode,7);assert.equal(output.stdout.trim(),'value=42');assert.equal(text(output,'app/out/result.txt'),'value=42');assert.equal(text(output,'app/input.txt'),'value=');
});
await test('Filesystem deltas report created, unchanged and deleted files accurately',async()=>{
 assert.equal(output.files.length,2);assert.deepEqual(output.changedFiles.map(f=>f.path),['app/out/result.txt']);assert.deepEqual(output.removedFiles,['app/delete.txt']);assert.equal(output.fileBytes,14);
});
await test('Ephemeral executions have separate filesystem workspaces',async()=>{
 const missing=await run(program);assert.equal(missing.success,false);assert.match(missing.error.type,/FileNotFoundException/);assert.equal(missing.files.length,0);
});
await test('Files are captured even when managed user code throws',async()=>{
 const failing=await compile('System.IO.File.WriteAllText("partial.txt","saved");throw new System.InvalidOperationException("expected failure");');
 const r=await run(failing);assert.equal(r.success,false);assert.match(r.error.message,/expected failure/);assert.equal(text(r,'partial.txt'),'saved');
});
await test('Persistent workspace seeds files and exposes configured quotas',async()=>{
 const r=await workspace({operation:'create',files:[file('counter.txt','1')],maxFileBytes:64,maxFileCount:8});assert.equal(r.success,true,json(r));assert.equal(r.maxFileBytes,64);assert.equal(r.maxFileCount,8);id=r.workspaceId;
 library=await compile('using System.IO;public class Counter {public static int Increment(){int n=int.Parse(File.ReadAllText("counter.txt"))+1;File.WriteAllText("counter.txt",n.ToString());return n;}public static T Echo<T>(T value){File.WriteAllText("echo.txt",value!.ToString());return value;}}',{outputKind:'library'});
});
await test('Invoke real managed methods with a persistent working filesystem',async()=>{
 const r=await invoke(library,'Counter','Increment',[],{workspaceId:id});assert.equal(r.success,true,json(r));assert.equal(r.result,2);assert.equal(text(r,'counter.txt'),'2');assert.equal(r.workspaceId,id);
});
await test('File-aware invocation preserves generic and exact-signature options',async()=>{
 const r=await invoke(library,'Counter','Echo',[42],{workspaceId:id,invokeOptions:{genericArguments:['int'],parameterTypes:['int']}});assert.equal(r.success,true,json(r));assert.equal(r.result,42);assert.equal(text(r,'echo.txt'),'42');
});
await test('Persistent execution supports delta-only capture',async()=>{
 const r=await invoke(library,'Counter','Increment',[],{workspaceId:id,captureFiles:false});assert.equal(r.result,3);assert.equal(r.files,undefined);assert.equal(text(r,'counter.txt','changedFiles'),'3');
});
await test('Workspace write, selected read, list and delete operate on runtime bytes',async()=>{
 let r=await workspace({operation:'write',workspaceId:id,files:[file('nested/data.bin',new Uint8Array([0,255,17]))]});assert.equal(r.success,true,json(r));
 r=await workspace({operation:'read',workspaceId:id,paths:['nested/data.bin']});assert.equal(r.files.length,1);assert.deepEqual([...Buffer.from(r.files[0].base64,'base64')],[0,255,17]);
 r=await workspace({operation:'list',workspaceId:id});assert.equal(r.entries.length,3);assert.equal(r.files,null);
 r=await workspace({operation:'delete',workspaceId:id,paths:['nested/data.bin']});assert.equal(r.success,true,json(r));assert.equal(r.entries.length,2);
});
await test('Absolute paths and traversal are rejected without host file writes',async()=>{
 for(const path of ['../escape','/absolute','C:/windows','dir/../../escape']){const r=await workspace({operation:'write',workspaceId:id,files:[file(path,'invalid')]});assert.equal(r.success,false,path);assert.match(r.error.message,/relative|escapes/);}
 const r=await run(program,{workingDirectory:'../escape'});assert.equal(r.success,false);assert.match(r.error.message,/escapes/);
});
await test('Persistent transfer validation is atomic for byte quotas and duplicate paths',async()=>{
 let r=await workspace({operation:'write',workspaceId:id,files:[file('safe.txt','valid'),file('big.txt','x'.repeat(65))]});assert.equal(r.success,false);assert.match(r.error.message,/maxFileBytes/);
 r=await workspace({operation:'write',workspaceId:id,files:[file('duplicate.txt','a'),file('./duplicate.txt','b')]});assert.equal(r.success,false);assert.match(r.error.message,/Duplicate/);
 r=await workspace({operation:'list',workspaceId:id});assert.equal(r.entries.length,2);
});
await test('Per-execution file count and generated output byte limits are enforced',async()=>{
 let r=await run(program,{files:[file('a','1'),file('b','2')],maxFileCount:1});assert.equal(r.success,false);assert.match(r.error.message,/maxFileCount/);
 const writes=await compile('System.IO.File.WriteAllBytes("big.bin",new byte[65]);');r=await run(writes,{maxFileBytes:64});assert.equal(r.success,false);assert.match(r.error.message,/maxFileBytes/);assert.equal(r.files,undefined);
});
await test('Concurrent file-aware calls retain independent CWD, stdout and contents',async()=>{
 const source=await compile('using System;using System.IO;using System.Threading.Tasks;await Task.Yield();string value=File.ReadAllText("input.txt");Console.WriteLine(value);File.WriteAllText("output.txt",value);');
 const result=await Promise.all(['one','two','three'].map(value=>run(source,{files:[file('input.txt',value)]})));
 for(let i=0;i<result.length;i++){assert.equal(result[i].success,true,json(result[i]));assert.equal(result[i].stdout.trim(),['one','two','three'][i]);assert.equal(text(result[i],'output.txt'),['one','two','three'][i]);}
});
await test('Disposing a workspace invalidates its identifier',async()=>{
 const r=await workspace({operation:'dispose',workspaceId:id});assert.equal(r.success,true);assert.equal((await workspace({operation:'list',workspaceId:id})).success,false);assert.equal((await invoke(library,'Counter','Increment',[],{workspaceId:id})).success,false);
});
const report={testedAt:new Date().toISOString(),environment:'Actual .NET 10 browser-wasm runtime hosted by Node',runtime:JSON.parse(bridge.Version()),passed:records.filter(t=>t.status==='passed').length,failed:records.filter(t=>t.status==='failed').length,tests:records};
await writeFile(new URL('../docs/wasm-files-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed} passed; ${report.failed} failed`);process.exit(report.failed?1:0);
