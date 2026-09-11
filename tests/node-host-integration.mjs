// Production Node entry point, actual .NET WASM, without browser-global shims.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRoslyn } from '../src/node/index.js';

const checks = [], events = [];
const globals = {Worker:globalThis.Worker,self:globalThis.self};
let compiler, second;
const succeed = result => { assert.equal(result.success,true,JSON.stringify(result.error||result.diagnostics)); return result; };
async function check(name, action) {
  const started = performance.now();
  const evidence = await action();
  checks.push({name,passed:true,milliseconds:performance.now()-started,evidence});
  console.log('PASS',name);
}
const watchdog = setTimeout(() => {compiler?.dispose();second?.dispose();console.error('Node integration exceeded 180 seconds');process.exitCode=1;},180000);
try {
  await check('Default Node host boots bundled Roslyn WASM and preserves caller globals', async () => {
    compiler = await createRoslyn({startupTimeoutMs:90000,onEvent:event=>events.push(event)});
    assert.match(compiler.info.roslynVersion,/^5\./);
    assert(compiler.info.referenceCount>100);
    assert(events.some(event=>event.stage==='ready'));
    assert.equal(globalThis.Worker,globals.Worker);
    assert.equal(globalThis.self,globals.self);
    return compiler.info;
  });
  let assembly;
  await check('C# emits real PE and portable PDB, then runs on all execution backends', async () => {
    assembly = succeed(await compiler.compile('System.Console.WriteLine("node:" + (6 * 7)); return 3;', {assemblyName:'NodeHostProgram',includeInspection:true}));
    assert(assembly.pe.length>512);
    assert(assembly.pdb.length>100);
    const results = [];
    for (const backend of ['wasm','javascript','native-wasm','auto']) {
      const result = succeed(await compiler.run(assembly,{backend}));
      assert.equal(result.stdout.trim(),'node:42');
      assert.equal(result.exitCode,3);
      results.push({requested:backend,backend:result.backend,stdout:result.stdout,exitCode:result.exitCode});
    }
    return {peBytes:assembly.pe.length,pdbBytes:assembly.pdb.length,results};
  });
  await check('Node host emits reusable JS and native Wasm artifacts with warm compilation caches', async () => {
    const result = {};
    for (const method of ['emitJavaScript','emitWasm']) {
      const first = await compiler[method](assembly);
      const second = await compiler[method](assembly);
      assert(second.cache.emitHit);
      assert.equal(succeed(await compiler.run(second)).stdout.trim(),'node:42');
      result[method] = {format:first.format,cache:second.cache,bytes:first.bytes?.length,characters:first.source?.length};
    }
    return result;
  });
  await check('File URL compiler references and NuGet archives work through the public Node host', async () => {
    assert.equal((await compiler.loadCompilerReferences()).length,2);
    assert.equal((await compiler.loadTaskReferences()).length,2);
    const archive = await readFile(new URL('./fixtures/newtonsoft.json.13.0.3.nupkg',import.meta.url));
    const pkg = await compiler.importPackage(archive,{targetFramework:'net10.0'});
    const compiled = succeed(await compiler.compile('using Newtonsoft.Json; System.Console.WriteLine(JsonConvert.SerializeObject(new { Value = 42 }));'));
    const result = succeed(await compiler.run(compiled));
    assert.deepEqual(JSON.parse(result.stdout),{Value:42});
    return {package:pkg.id,version:pkg.version,stdout:result.stdout};
  });
  await check('Managed objects, Int64 values, dynamic compilation and workspace files remain available', async () => {
    const library = succeed(await compiler.compile('public class Counter { public long Value {get;set;} public Counter(long value){Value=value;} public long Add(long value)=>Value+=value; }',{outputKind:'library'}));
    const handle = await compiler.createObject(library.assemblyId,'Counter',[9007199254740993n]);
    assert.equal(await compiler.getProperty(handle,'Value'),9007199254740993n);
    assert.equal(succeed(await compiler.invokeObject(handle,'Add',[2n])).result,9007199254740995n);
    await compiler.releaseObject(handle);
    assert.equal(succeed(await compiler.evaluate('6 * 7',{returnType:'int'})).result,42);
    const workspace = await compiler.createWorkspace({files:{'input.txt':'node files'}});
    const fileProgram = succeed(await compiler.compile('using System.IO; File.WriteAllText("output.txt", File.ReadAllText("input.txt").ToUpperInvariant());'));
    succeed(await compiler.run(fileProgram,{workspaceId:workspace.workspaceId}));
    const output = await compiler.readWorkspace(workspace.workspaceId,['output.txt']);
    assert.equal(new TextDecoder().decode(output.files['output.txt']),'NODE FILES');
    await compiler.disposeWorkspace(workspace.workspaceId);
    return {bigInt:true,objects:true,dynamicResult:42,workspaceText:'NODE FILES'};
  });
  await check('A second compiler owns an independent runtime and reference collection', async () => {
    second = await createRoslyn({baseUrl:new URL('../dist/',import.meta.url),startupTimeoutMs:90000});
    const references = await second.references();
    assert(!references.some(reference=>/Newtonsoft/.test(reference.name)));
    const compilation = succeed(await second.compile('System.Console.WriteLine("isolated");'));
    assert.equal(succeed(await second.run(compilation)).stdout.trim(),'isolated');
    await second.close();
    assert.equal(second.disposed,true);
    return {independentReferences:true};
  });
  await check('A runaway C# execution is terminated by timeout and close awaits worker exit', async () => {
    const infinite = succeed(await compiler.compile('while (true) { }'));
    const start = performance.now();
    await assert.rejects(compiler.run(infinite,{timeoutMs:100}),{code:'TIMEOUT'});
    await compiler.close();
    assert.equal(compiler.disposed,true);
    await assert.rejects(compiler.compile('return 0;'),{code:'DISPOSED'});
    return {milliseconds:performance.now()-start,disposed:true};
  });
} catch (error) {
  checks.push({name:'Failure',passed:false,error:{message:error.message,stack:error.stack,code:error.code}});
  console.error(error);
  process.exitCode=1;
} finally {
  clearTimeout(watchdog);
  await Promise.all([compiler?.close(),second?.close()]);
  await writeFile(new URL('../docs/node-host-verification.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),runtime:process.version,passed:checks.every(check=>check.passed),checks},null,2)+'\n');
  console.log(`${checks.filter(check=>check.passed).length} production Node host integration checks passed`);
}
