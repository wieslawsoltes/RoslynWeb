// Real browser integration. CI installs Playwright and its browser explicitly.
// BROWSER_ENGINE=chromium|firefox|webkit; BROWSER_BASE_URL=https://.../RoslynWeb/
// With no external URL, test the staged Pages artifact under its repository subpath.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const engine = process.env.BROWSER_ENGINE || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error(`Unknown BROWSER_ENGINE: ${engine}`);
const { [engine]: browserType } = await import('playwright');
const external = process.env.BROWSER_BASE_URL;
const reportDir = resolve(root, 'artifacts', 'browser-' + engine);
await mkdir(reportDir, { recursive: true });
const report = { engine, testedAt: new Date().toISOString(), realBrowser: true, tests: [], console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
const pageFailures = new WeakMap();
let server, browser, context, currentPage, portableWasmBytes;
const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 180000);

async function startServer() {
  const staged = resolve(root, 'artifacts/pages');
  await stat(resolve(staged, 'demo/index.html'));
  await stat(resolve(staged, 'dist/_framework/dotnet.js'));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.md': 'text/plain' };
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (!path.startsWith('/RoslynWeb/')) throw new Error('Request escaped the repository subpath');
      const relative = path.slice('/RoslynWeb/'.length);
      // Test harness is mounted alongside the actual, unmodified Pages artifact.
      const parent = relative.startsWith('tests/') ? root : staged;
      let file = resolve(parent, relative || 'index.html');
      if (!file.startsWith(parent + sep) && file !== parent) throw new Error('Invalid path');
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}/RoslynWeb/`;
}

async function test(name, action) {
  const started = performance.now();
  try {
    await action();
    report.tests.push({ name, passed: true, ms: Math.round(performance.now() - started) });
    console.log('PASS', name);
  } catch (error) {
    report.tests.push({ name, passed: false, error: error.stack || error.message, ms: Math.round(performance.now() - started) });
    throw error;
  }
}

async function pageFor(name) {
  const page = await context.newPage();
  currentPage = page;
  let rejectFatal;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  fatal.catch(() => {});
  pageFailures.set(page, fatal);
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') report.console.push({ page: name, type: message.type(), text: message.text() }); });
  page.on('pageerror', error => { report.pageErrors.push({ page: name, message: error.message, stack: error.stack }); rejectFatal(error); });
  page.on('requestfailed', request => report.failedRequests.push({ page: name, url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) report.httpErrors.push({ page: name, status: response.status(), url: response.url() }); });
  page.setDefaultTimeout(timeout);
  return page;
}

async function waitFor(page, expression, failureMessage) {
  const prior = report.pageErrors.length;
  await Promise.race([page.waitForFunction(expression, undefined, { timeout }), pageFailures.get(page)]).catch(async error => {
    const errors = report.pageErrors.slice(prior).map(e => e.message).join('\n');
    const state = await page.locator('body').innerText().catch(() => 'Page unavailable');
    throw new Error(`${failureMessage}\n${errors}\n${state}\n${error.message}`);
  });
}

async function runExample(page, label, backend, expected) {
  await page.locator('#example').selectOption({ label });
  await page.locator('#backend').selectOption(backend);
  await page.locator('#run').click();
  await waitFor(page, () => ['Finished', 'Compilation failed', 'JavaScript compilation failed', 'Native compilation failed', 'Execution failed', 'Error', 'Runtime unavailable'].includes(document.querySelector('#status')?.textContent), `Example did not finish: ${label}`);
  const output = await page.locator('#console').innerText();
  assert.equal(await page.locator('#status').innerText(), 'Finished', `${label}: ${output}`);
  for (const text of expected) assert.ok(output.includes(text), `${label}: missing ${JSON.stringify(text)} in ${output}`);
}

try {
  const baseUrl = new URL(external || await startServer());
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  report.baseUrl = baseUrl.href;
  browser = await browserType.launch({ headless: true });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await pageFor('demo');
  await test('Staged Pages application initializes its module Worker at a repository subpath', async () => {
    const response = await page.goto(new URL('demo/', baseUrl).href, { waitUntil: 'domcontentloaded', timeout });
    assert.equal(response.status(), 200);
    await waitFor(page, () => !!window.lab?.compiler || /unavailable|failed|error/i.test(document.querySelector('#status')?.textContent || ''), 'Compiler remained stuck during initialization');
    assert.equal(await page.locator('#status').innerText(), 'Ready', await page.locator('#console').innerText());
    assert.equal(await page.locator('#run').isEnabled(), true);
    assert.ok(await page.evaluate(() => window.lab.compiler.info.referenceCount >= 160));
    assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
    assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors));
  });
  await test('Demo compiles C#, emits a real PE/PDB and executes .NET WASM', async () => {
    await page.locator('#arguments').fill('["browser-ci"]');
    await runExample(page, 'Hello, browser', 'wasm', ['Hello from Roslyn in your browser!', 'Arguments: 1', 'Process exited with code 0 · wasm']);
    assert.deepEqual(await page.evaluate(() => ({ pe: [...window.lab.artifact.pe.slice(0, 2)], pdb: [...window.lab.artifact.pdb.slice(0, 4)] })), { pe: [77, 90], pdb: [66, 83, 74, 66] });
  });
  await test('Demo compiles emitted MSIL to JavaScript and executes it', () => runExample(page, 'Algorithms → JavaScript', 'javascript', ['Array total:\n30', 'Fibonacci(12):\n144', 'Process exited with code 0 · javascript']));

  await test('Demo exposes working reference, basic-block and numeric JavaScript optimization modes',async()=>{
    await page.locator('#example').selectOption({label:'Algorithms → JavaScript'});
    await page.locator('#backend').selectOption('javascript');
    const results=[];
    for(const [selected,expectedMode] of [['reference','reference'],['blocks','blocks'],['optimized','numeric']]){
      await page.locator('#optimization').selectOption(selected);
      await page.locator('#run').click();
      await waitFor(page,()=>['Finished','Compilation failed','Execution failed','Error'].includes(document.querySelector('#status')?.textContent),'Optimization example did not finish');
      assert.equal(await page.locator('#status').innerText(),'Finished',await page.locator('#console').innerText());
      const result=await page.evaluate(()=>({optimization:window.lab.javascriptArtifact?.optimization,output:document.querySelector('#console').textContent}));
      assert.equal(result.optimization.mode,expectedMode);assert(result.output.includes('Fibonacci(12):\n144'));
      results.push({selected,optimization:result.optimization});
    }
    await page.locator('#backend').selectOption('native-wasm');
    assert.equal(await page.locator('#optimization option[value="blocks"]').isDisabled(),true);
    report.demoOptimizationModes=results;
  });

  await test('Demo runs exact Decimal, nullable and tuple examples on both compiled backends',async()=>{
    for(const backend of ['javascript','native-wasm'])await runExample(page,'Decimal, nullable and tuples',backend,[
      'Exact decimal sum: 0.3','96-bit decimal: 79228162514264337593543950335','Round to even: 2.34',
      'Nullable fallback: 42','Original tuple: (3, value, 0.1)','Copied tuple: (99, value, 0.1)'
    ]);
  });

  await test('Demo compiles typed Int64 and floating kernels in all five compiler modes',async()=>{
    const results=[];
    for(const [backend,mode] of [['javascript','reference'],['javascript','blocks'],['javascript','optimized'],['native-wasm','reference'],['native-wasm','optimized']]){
      await page.locator('#example').selectOption({label:'Int64 and floating-point kernels'});
      await page.locator('#backend').selectOption(backend);
      await page.locator('#optimization').selectOption(mode);
      await page.locator('#run').click();
      await waitFor(page,()=>['Finished','Compilation failed','JavaScript compilation failed','Native compilation failed','Execution failed','Error'].includes(document.querySelector('#status')?.textContent),'Typed numeric example did not finish');
      const output=await page.locator('#console').innerText();
      assert.equal(await page.locator('#status').innerText(),'Finished',output);
      for(const expected of ['Int64 sum of squares:\n333833500','Double sum:\n250','Single sum:\n250','Clamped value:\n10','Finite double: True','Subnormal double: True'])assert(output.includes(expected),`${backend}/${mode}: ${output}`);
      const optimization=await page.evaluate(backend=>window.lab[backend==='javascript'?'javascriptArtifact':'wasmArtifact'].optimization,backend);
      if(backend==='javascript'&&mode==='optimized')assert(optimization.numericMethods>=3);
      if(backend==='native-wasm')assert(optimization.intrinsicCalls>=3);
      results.push({backend,mode,optimization});
    }
    report.typedNumericModes=results;
  });

  await test('Demo runs tuple interface indexing, managed comparers and hash contracts on both compilers',async()=>{
    for(const backend of ['javascript','native-wasm'])await runExample(page,'Tuple interfaces and comparers',backend,[
      'Tuple length: 9','Ninth item: 9','Structural equality: True','Structural comparison: 0',
      'Equal tuple hashes: True','Nullable NaN hash: True'
    ]);
  });

  await test('Demo shows exception-filter search before finally execution on both compiled backends',async()=>{
    for(const backend of ['javascript','native-wasm']){
      await runExample(page,'Exception filters → WebAssembly',backend,['Filter searched before finally','Callee finally executed','Filtered handler: 42']);
      const output=await page.locator('#console').innerText();
      assert(output.indexOf('Filter searched before finally')<output.indexOf('Callee finally executed'));
      assert(output.indexOf('Callee finally executed')<output.indexOf('Filtered handler: 42'));
    }
  });


  await test('Demo compiles C# through real MSIL to native WebAssembly and executes catch/finally', async () => {
    await runExample(page, 'C# → native WebAssembly', 'native-wasm', [
      'Running directly compiled WebAssembly', '333833500', '6765',
      'Native catch handler executed', 'Native finally handler executed', 'Process exited with code 0 · native-wasm'
    ]);
    const emitted = await page.evaluate(async () => {
      const artifact = window.lab.wasmArtifact;
      const module = await WebAssembly.compile(artifact.bytes);
      return {success:artifact.success,format:artifact.format,header:[...artifact.bytes.slice(0,8)],
        pe:[...window.lab.artifact.pe.slice(0,2)],module:module instanceof WebAssembly.Module,
        valid:WebAssembly.validate(artifact.bytes),bytes:artifact.bytes.length,
        exports:WebAssembly.Module.exports(module),imports:WebAssembly.Module.imports(module)};
    });
    assert.equal(emitted.success,true); assert.equal(emitted.format,'wasm');
    assert.deepEqual(emitted.header,[0,97,115,109,1,0,0,0]); assert.deepEqual(emitted.pe,[77,90]);
    assert.equal(emitted.module,true); assert.equal(emitted.valid,true);
    assert(emitted.exports.some(item=>item.kind==='function'),'The emitted module must contain native function exports');
    assert(emitted.imports.some(item=>item.kind==='function'),'The Console example must declare its runtime-service imports');
    await page.locator('#tab-wasm').click();
    assert.equal(await page.locator('#panel-wasm').isVisible(),true);
    const displayed=JSON.parse(await page.locator('#panel-wasm').innerText());
    assert.equal(displayed.format,'wasm'); assert.equal(displayed.bytes,emitted.bytes);
    assert.equal(await page.locator('#download-wasm').isEnabled(),true);
    report.nativeDemo=emitted;
    await page.screenshot({path:resolve(reportDir,'native-wasm.png'),fullPage:true});
  });
  await test('Demo downloads the actual executable WebAssembly bytes', async () => {
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-wasm').click()]);
    assert.equal(download.suggestedFilename(),'BrowserWasmProgram.wasm');
    const target=resolve(reportDir,'BrowserWasmProgram.wasm'); await download.saveAs(target);
    const bytes=new Uint8Array(await readFile(target));
    assert.deepEqual([...bytes.slice(0,8)],[0,97,115,109,1,0,0,0]);
    assert.equal(WebAssembly.validate(bytes),true);
    assert.deepEqual([...bytes],await page.evaluate(()=>[...window.lab.wasmArtifact.bytes]));
    report.nativeDownload={file:download.suggestedFilename(),bytes:bytes.length,valid:true};
  });
  await test('Browser Worker API emits a reusable native library with exact Int64 and real Wasm exports',async()=>{
    const result=await page.evaluate(async()=>{
      const {loadWasm}=await import('../src/wasm/index.js');
      const source='public static class BrowserNativeApi { public static int Twice(int value) => value * 2; public static long SumSquares(int n) { long sum = 0; for (int i = 1; i <= n; i++) sum += (long)i * i; return sum; } }';
      const options={outputKind:'library',assemblyName:'BrowserNativeApiVerification'};
      const first=await window.lab.compiler.compileToWasm(source,options);
      const second=await window.lab.compiler.compileToWasm(source,options);
      if(!first.success||!second.success)throw new Error(JSON.stringify(first.success?second:first));
      const emitted=await window.lab.compiler.emitWasm(first.assembly.assemblyId);
      const program=await loadWasm(second.bytes);
      try {
        const method=program.manifest.methods.find(m=>m.type==='BrowserNativeApi'&&m.name==='Twice');
        if(!method)throw new Error('Native Twice method export is missing');
        return {bytes:[...second.bytes],reEmitted:[...emitted.bytes],pdb:first.assembly.pdbBase64,
          module:program.module instanceof WebAssembly.Module,instance:program.instance instanceof WebAssembly.Instance,
          imports:WebAssembly.Module.imports(program.module),nativeResult:program.instance.exports[method.exportName](21),
          longResult:String(program.invoke('BrowserNativeApi::SumSquares',[1000])),
          cache:second.assembly.performance.cache,emissionCache:second.cache};
      } finally {program.dispose();}
    });
    assert.equal(result.module,true); assert.equal(result.instance,true); assert.deepEqual(result.imports,[]);
    assert.equal(result.nativeResult,42); assert.equal(result.longResult,'333833500');
    assert.equal(result.pdb,null); assert.equal(result.cache.syntaxHits,1); assert.equal(result.cache.compilationReused,true);
    assert.deepEqual(result.reEmitted,result.bytes);
    portableWasmBytes=result.bytes;
    report.nativeApi={bytes:result.bytes.length,module:true,instance:true,imports:result.imports,nativeResult:result.nativeResult,longResult:result.longResult,cache:result.cache,emissionCache:result.emissionCache};
  });
  await test('Browser native compilation reports unsupported native DLL imports without execution fallback',async()=>{
    const result=await page.evaluate(async()=>{
      const source='public static class BrowserNativeImport { [System.Runtime.InteropServices.DllImport("unsupported-browser-native.dll")] public static extern int Native(); public static int Main() => Native(); }';
      const output=await window.lab.compiler.compileToWasm(source,{assemblyName:'BrowserNativeImportVerification'});
      return {success:output.success,stage:output.stage,csharpSucceeded:output.assembly?.success,diagnostics:output.diagnostics,error:output.error};
    });
    assert.equal(result.success,false,JSON.stringify(result)); assert.equal(result.stage,'wasm'); assert.equal(result.csharpSucceeded,true);
    assert(result.diagnostics?.some(d=>d.severity==='error'),'Native imports need an explicit compile diagnostic');
    report.nativeUnsupported=result;
  });

  await test('Browser compiles reusable optimized JavaScript with real PE and a repeated emission cache hit',async()=>{
    const result=await page.evaluate(async()=>{
      const source='public static class BrowserJavaScriptV6 { static int state; public static int Next() => ++state; public static int Sum(int n) { int result=0; for(int i=0;i<n;i++) result+=i*(i+1); return result; } }';
      const runtimeImport=new URL('../src/il/runtime.mjs',location.href).href;
      const options={outputKind:'library',assemblyName:'BrowserJavaScriptV6',javascript:{runtimeImport}};
      const first=await window.lab.compiler.compileToJavaScript(source,options);
      const second=await window.lab.compiler.compileToJavaScript(source,options);
      if(!first.success||!second.success)throw new Error(JSON.stringify(first.success?second:first));
      window.v6PortableJavaScriptSource=second.source;
      const url=URL.createObjectURL(new Blob([second.source],{type:'text/javascript'}));
      try{
        const module=await import(url),one=module.createAssembly(),two=module.createAssembly();
        return{success:second.success,format:second.format,pe:[...second.assembly.pe.slice(0,2)],cache:second.cache,
          optimization:second.optimization,sum:one.invoke('BrowserJavaScriptV6::Sum',[100]),
          state:[one.invoke('BrowserJavaScriptV6::Next'),one.invoke('BrowserJavaScriptV6::Next'),two.invoke('BrowserJavaScriptV6::Next')],
          sameSource:first.source===second.source};
      }finally{URL.revokeObjectURL(url);}
    });
    assert.equal(result.success,true);assert.equal(result.format,'javascript');assert.deepEqual(result.pe,[77,90]);
    assert.equal(result.sum,333300);assert.deepEqual(result.state,[1,2,1]);assert.equal(result.sameSource,true);
    assert.equal(result.cache.emitHit,true);assert(result.optimization.numericMethods>=1);
    report.javascriptV6=result;
  });

  await test('Browser optimized and reference compilers preserve Decimal, nullable and tuple values',async()=>{
    const results=await page.evaluate(async()=>{
      const source='using System; public static class BrowserValuesV6 { public static void Main(){decimal a=0.1m,b=0.2m; Console.WriteLine(a+b); int? value=42; Console.WriteLine(value.Value); var original=(3,7); var copy=original; copy.Item1=99; Console.WriteLine(original.ToString());}}';
      const results=[];
      for(const backend of ['javascript','native-wasm'])for(const optimize of [false,true]){
        const options={assemblyName:'BrowserValuesV6_'+backend.replace('-','_')+'_'+optimize};
        const artifact=backend==='javascript'
          ?await window.lab.compiler.compileToJavaScript(source,{...options,javascript:{optimize}})
          :await window.lab.compiler.compileToWasm(source,{...options,wasm:{optimize}});
        if(!artifact.success)throw new Error(JSON.stringify(artifact));
        const result=await window.lab.compiler.run(artifact);
        results.push({backend,optimize,success:result.success,stdout:result.stdout,actualBackend:result.backend,error:result.error});
      }
      return results;
    });
    for(const result of results){assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.actualBackend,result.backend);assert.equal(result.stdout,'0.3\n42\n(3, 7)\n');}
    report.compilerValueParity=results;
  });

  await test('Browser JavaScript and native Wasm search exception filters before unwinding a callee finally',async()=>{
    const results=await page.evaluate(async()=>{
      const source='using System; public static class BrowserFiltersV6 { static int state; static bool Match(){state=state*10+1;return true;} static void Throw(){try{throw new InvalidOperationException();}finally{state=state*10+3;}} public static void Main(){try{Throw();}catch(InvalidOperationException)when(Match()){Console.WriteLine(state*10+4);}}}';
      const results=[];
      for(const backend of ['javascript','native-wasm']){
        const options={assemblyName:'BrowserFiltersV6_'+backend.replace('-','_')};
        const artifact=backend==='javascript'?await window.lab.compiler.compileToJavaScript(source,options):await window.lab.compiler.compileToWasm(source,options);
        if(!artifact.success)throw new Error(JSON.stringify(artifact));
        results.push({backend,...await window.lab.compiler.run(artifact)});
      }
      return results;
    });
    for(const result of results){assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdout,'134\n');}
    report.compilerFilterParity=results;
  });

  if (!external || process.env.BROWSER_FULL_DEMO === '1') {
    await test('Demo executes real source generators and analyzers', async () => {
      await runExample(page, 'Source generator & analyzer', 'wasm', ['Hello from a real Roslyn source generator!', 'Analyzer inspected this method.']);
      assert.ok((await page.locator('#diagnostics').innerText()).includes('LAB001'));
      assert.ok((await page.locator('#panel-generated').textContent()).includes('class GeneratedValues'));
    });
    await test('Demo builds an imported project target and generated source', () => runExample(page, '.csproj and imported targets', 'wasm', ['Built from a .csproj inside the browser.', '\n42\n']));
    await test('Demo accesses a persistent managed object', () => runExample(page, 'CLR object handles', 'wasm', ['Counter.Value after managed instance invocation: 42']));
    await test('Demo compiles a runtime C# function with lossless Int64', () => runExample(page, 'Runtime-generated C# function', 'wasm', ['Generated function result: 18014398509481986']));
    await test('Demo browser controls invoke their managed event method', async () => {
      await runExample(page, 'Browser UI from C#', 'wasm', ['Browser controls connected to the managed DesktopDemo class.']);
      const host = page.locator('#panel-host');
      assert.equal(await host.isVisible(), true);
      await host.getByRole('button', { name: 'Increment in C#' }).click();
      await waitFor(page, () => [...document.querySelectorAll('#panel-host label, #panel-host span, #panel-host div')].some(e => e.textContent === '1'), 'Managed UI event did not update the counter');
      await host.getByRole('button', { name: 'Increment in C#' }).click();
      await waitFor(page, () => [...document.querySelectorAll('#panel-host label, #panel-host span, #panel-host div')].some(e => e.textContent === '2'), 'Second managed UI event did not update the counter');
    });
    await test('Demo builds embedded RESX resources', () => runExample(page, 'Embedded RESX resources', 'wasm', ['Hello from embedded RESX resources!', '\n42\n']));
    await test('Demo executes a genuine custom MSBuild task', () => runExample(page, 'Custom managed MSBuild task', 'wasm', ['Generated by a real managed MSBuild task:', '\n42\n']));
    await test('Demo executes C# Reflection.Emit as JavaScript', () => runExample(page, 'C# Reflection.Emit → JavaScript', 'javascript', ['\n42\n']));
    await test('Demo executes virtual files and binary streams as JavaScript', () => runExample(page, 'Virtual files and binary streams', 'javascript', ['9007199254740993', 'Binary stream round trip', 'Hello from the virtual filesystem!']));
    await test('Demo transfers real managed filesystem inputs and outputs', () => runExample(page, 'Managed filesystem workspace', 'wasm', ['Hello from JavaScript file input!', 'File results/output.txt: HELLO FROM JAVASCRIPT FILE INPUT!']));
    await test('Demo builds and invokes a dynamic CLR type as JavaScript', () => runExample(page, 'Dynamic CLR type → JavaScript', 'javascript', ['\n42\n']));
    await test('Demo executes native WASI code through MSBuild Exec', () => runExample(page, 'Native WASI build task', 'wasm', ['Generated by a native C command compiled to WASI:', '\n42\n']));
    await test('Original WinForms DLL executes unchanged and its managed event updates the DOM',async()=>{
      await runExample(page,'Original WinForms DLL','wasm',['Loaded the original DLL compiled against Microsoft desktop references; its bytes are unchanged.','Original managed event handlers are connected']);
      await page.locator('#panel-host').getByRole('button',{name:'Increment original DLL',exact:true}).click();
      await waitFor(page,()=>document.querySelector('#panel-host')?.textContent.includes('Count: 1'),'Original WinForms Click handler did not update its Label');
      const input=page.locator('#panel-host input[type="text"]');
      await input.fill(''); await input.pressSequentially('rapid browser text');
      await waitFor(page,()=>document.querySelector('#console')?.textContent.includes('text:rapid browser text'),'Original TextChanged handler did not receive the final browser edit');
      assert.equal(await input.inputValue(),'rapid browser text');
    });
    await test('Original WPF DLL executes unchanged and its routed event updates the DOM',async()=>{
      await runExample(page,'Original WPF DLL','wasm',['Loaded the original DLL compiled against Microsoft desktop references; its bytes are unchanged.','Original managed event handlers are connected']);
      await page.locator('#panel-host').getByRole('button',{name:'Increment original WPF',exact:true}).click();
      await waitFor(page,()=>document.querySelector('#panel-host')?.textContent.includes('WPF count: 1'),'Original WPF Click handler did not update its TextBlock');
    });
    await test('Portable native module executes after the Roslyn Worker is disposed',async()=>{
      assert(portableWasmBytes?.length,'The native browser API fixture must have been compiled');
      const result=await page.evaluate(async bytes=>{
        const compiler=window.lab.compiler; compiler.dispose();
        let code;try{await compiler.compile('public class MustNotCompile {}',{outputKind:'library'});}catch(error){code=error.code;}
        const {loadWasm}=await import('../src/wasm/index.js');
        const program=await loadWasm(new Uint8Array(bytes));
        try{return{disposed:compiler.disposed,rejectedCode:code,module:program.module instanceof WebAssembly.Module,
          instance:program.instance instanceof WebAssembly.Instance,imports:WebAssembly.Module.imports(program.module),
          result:String(program.invoke('BrowserNativeApi::SumSquares',[1000])),twice:program.invoke('BrowserNativeApi::Twice',[21])};}
        finally{program.dispose();}
      },portableWasmBytes);
      assert.equal(result.disposed,true);assert.equal(result.rejectedCode,'DISPOSED');
      assert.equal(result.module,true);assert.equal(result.instance,true);assert.deepEqual(result.imports,[]);
      assert.equal(result.result,'333833500');assert.equal(result.twice,42);
      report.nativePortable=result;
    });
    await test('Saved JavaScript module executes after the Roslyn Worker is disposed',async()=>{
      const result=await page.evaluate(async()=>{
        if(!window.lab.compiler.disposed)throw new Error('Roslyn must be disposed for this check');
        const url=URL.createObjectURL(new Blob([window.v6PortableJavaScriptSource],{type:'text/javascript'}));
        try{const module=await import(url);const runtime=module.createAssembly();return{sum:runtime.invoke('BrowserJavaScriptV6::Sum',[100]),next:runtime.invoke('BrowserJavaScriptV6::Next')};}
        finally{URL.revokeObjectURL(url);}
      });
      assert.deepEqual(result,{sum:333300,next:1});report.javascriptPortable=result;
    });
    await test('Restart compiler creates a working replacement Worker', async () => {
      await page.locator('#restart').click();
      await waitFor(page, () => document.querySelector('#status')?.textContent === 'Ready', 'Compiler restart did not complete');
      await runExample(page, 'Hello, browser', 'wasm', ['Hello from Roslyn in your browser!']);
    });
    await test('Demo reports source diagnostics and remains usable', async () => {
      await page.locator('#example').selectOption({ label: 'Compiler diagnostics' });
      await page.locator('#compile').click();
      await waitFor(page, () => document.querySelector('#status')?.textContent === 'Compilation failed', 'Expected source diagnostics');
      assert.ok((await page.locator('#diagnostics').innerText()).includes('CS0029'));
      await runExample(page, 'Hello, browser', 'wasm', ['Hello from Roslyn in your browser!']);
    });
  }
  await page.screenshot({ path: resolve(reportDir, 'demo.png'), fullPage: true });
  await page.close();

  if (!external) {
    const harness = await pageFor('browser-suite');
    await test('Direct browser runtime, Worker protocol, package decompression and timeout suite', async () => {
      const response = await harness.goto(new URL('tests/browser.html', baseUrl).href, { waitUntil: 'domcontentloaded', timeout });
      assert.equal(response.status(), 200, 'Browser test harness must be served successfully');
      await waitFor(harness, () => document.documentElement.dataset.complete === 'true' || document.querySelector('#status')?.textContent === 'BOOT FAILED', 'Browser API suite did not complete');
      report.browserSuite = await harness.locator('body').innerText();
      console.log(report.browserSuite);
      assert.equal(await harness.locator('html').getAttribute('data-failures'), '0', report.browserSuite);
    });
    await harness.screenshot({ path: resolve(reportDir, 'browser-suite.png'), fullPage: true });
  }
  assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
  assert.equal(report.httpErrors.length, 0, JSON.stringify(report.httpErrors));
} catch (error) {
  report.error = error.stack || error.message;
  console.error(report.error);
  console.error(JSON.stringify({ pageErrors: report.pageErrors, failedRequests: report.failedRequests, httpErrors: report.httpErrors }, null, 2));
  await currentPage?.screenshot({ path: resolve(reportDir, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  report.passed = report.tests.filter(t => t.passed).length;
  report.failed = report.tests.filter(t => !t.passed).length;
  await writeFile(resolve(reportDir, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed} browser checks passed; ${report.failed} failed`);
}
