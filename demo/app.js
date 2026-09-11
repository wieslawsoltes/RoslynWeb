import { createRoslyn } from '../src/browser.js';
import { examples as baseExamples } from './examples.js';
import {workflowExamples,prepareExample,projectFiles} from './workflows.js';
import {advancedExamples,resourceProjectFiles,customTaskProjectFiles} from './advanced-workflows.js';
import {compatibilityExamples,nativeTaskProject} from './compatibility-workflows.js';
const examples=[...baseExamples,...workflowExamples,...advancedExamples,...compatibilityExamples];
const $ = id => document.getElementById(id);
const source = $('source');
let compiler, artifact, wasmArtifact, jsSource = '', busy = false, sourceVersion = 0, compiledVersion = -1;
let initializationController, initializationVersion = 0, desktopHost, desktopCompatibility;
window.lab = { get compiler() { return compiler; }, get artifact() { return artifact; }, get wasmArtifact() { return wasmArtifact; } };
function log(message, append = true) { $('console').textContent = (append ? $('console').textContent : '') + message + '\n'; }
function status(text) { $('status').textContent = text; }
function controls() {
  const ready = compiler && !compiler.disposed;
  $('compile').disabled = !ready || busy; $('run').disabled = !ready || busy;
  $('stop').disabled = !ready; $('restore').disabled = !ready || busy; $('upload').disabled = !ready || busy;
  $('download-wasm').disabled = !wasmArtifact?.success || busy;
  $('download').disabled = !artifact?.success; $('download-js').disabled = !jsSource || !artifact?.success;
}
function dirty() { sourceVersion++; $('dirty').hidden = false; artifact = null; wasmArtifact = null; jsSource = ''; controls(); }
function lines() { $('line-numbers').textContent = Array.from({ length: source.value.split('\n').length }, (_, i) => i + 1).join('\n'); position(); }
function position() { const prefix = source.value.slice(0, source.selectionStart).split('\n'); $('position').textContent = `Ln ${prefix.length}, Col ${prefix.at(-1).length + 1}`; }
function tab(name) {
  for (const el of document.querySelectorAll('[data-tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === name));
  for (const n of ['source', 'il', 'js', 'wasm', 'generated', 'host']) $('panel-' + n).hidden = n !== name;
}
function diagnostics(items = []) {
  $('diagnostics').replaceChildren();
  for (const diagnostic of items) {
    const button = document.createElement('button'); button.className = 'diagnostic';
    button.textContent = `${diagnostic.severity} ${diagnostic.id || diagnostic.code} · ${diagnostic.path || 'Program.cs'}:${diagnostic.startLine || 1}:${diagnostic.startColumn || 1} — ${diagnostic.message}`;
    button.onclick = () => {
      tab('source'); source.focus();
      const offset = source.value.split('\n').slice(0, Math.max(0, (diagnostic.startLine || 1) - 1)).reduce((n, s) => n + s.length + 1, 0) + Math.max(0, (diagnostic.startColumn || 1) - 1);
      source.setSelectionRange(offset, offset); position();
    };
    $('diagnostics').append(button);
  }
}
function ilText(model) {
  const methods = model.methods || (model.types || []).flatMap(type => type.methods || []);
  return methods.map(method => {
    const signature = `.method ${method.declaringType || ''}::${method.name}(${(method.parameters || method.parameterTypes || []).map(p => typeof p === 'string' ? p : p.type).join(', ')})`;
    return signature + '\n{\n' + (method.instructions || (Array.isArray(method.body) ? method.body : method.body?.instructions) || []).map(op => '    IL_' + op.offset.toString(16).padStart(4, '0') + ':  ' + (op.opCode || op.opcode || op.op) + (op.operand === undefined || op.operand === null ? '' : '  ' + (typeof op.operand === 'object' ? JSON.stringify(op.operand) : op.operand))).join('\n') + '\n}';
  }).join('\n\n') || JSON.stringify(model, null, 2);
}
async function initialize() {
  const attempt = ++initializationVersion;
  initializationController?.abort();
  desktopHost?.dispose(); desktopHost = null;
  desktopCompatibility?.dispose().catch(() => {}); desktopCompatibility = null;
  initializationController = new AbortController();
  compiler?.dispose(); compiler = null; controls(); status('Loading runtime'); $('restart').hidden = false; $('restart').disabled = false;
  log('Starting the compiler worker…', false);
  const started = performance.now();
  try {
    const created = await createRoslyn({ signal: initializationController.signal, baseUrl: new URL('../dist/', import.meta.url).href, onEvent(event) {
      if(attempt !== initializationVersion) return;
      if (event.type === 'progress') { status(event.message); log(event.message, false); }
      if (event.type === 'package') status(event.message || `Restoring ${event.id || 'package'}`);
    } });
    if(attempt !== initializationVersion) { created.dispose(); return; }
    compiler = created;
    const i = compiler.info;
    $('runtime-info').textContent = `Roslyn ${i.roslynVersion || ''} · .NET ${i.runtimeVersion || ''} · ${i.referenceCount || ''} references`;
    status('Ready'); log(`Compiler ready in ${((performance.now() - started) / 1000).toFixed(1)}s. Choose an example or write C#, then Run.`, false);
    $('packages').replaceChildren();
    const li = document.createElement('li'); li.textContent = `.NET ${i.runtimeVersion || '10'} · ${i.referenceCount || ''} reference assemblies`; $('packages').append(li);
  } catch (error) { if(attempt !== initializationVersion) return; status('Runtime unavailable'); log(error.stack || error.message, false); log('Use Restart compiler to retry. The failure above identifies the asset or runtime operation that could not load.'); }
  $('restart').disabled = false;
  controls();
}
function operationContext() {
  const generation = initializationVersion, activeCompiler = compiler;
  return {
    compiler: activeCompiler, signal: initializationController?.signal,
    current: () => generation === initializationVersion && activeCompiler === compiler,
    check() { if (!this.current()) throw new Error('Operation canceled by a compiler restart.'); }
  };
}
async function compile(context) {
  const activeCompiler = context.compiler;
  const version = sourceVersion, text = source.value;
  const started = performance.now(); status('Compiling'); diagnostics([]); log('Compiling Program.cs…', false);
  const example = examples[Number($('example').value)];
  const extensionOptions = await prepareExample(activeCompiler, example); context.check();
  let compiled, nativeResult;
  wasmArtifact = null;
  if (example?.kind === 'desktop-binary') {
    if (!desktopCompatibility) {
      desktopHost?.dispose(); desktopHost = null;
      const {createDesktopCompatibility} = await import('../src/hosting/index.js'); context.check();
      const created = await createDesktopCompatibility({compiler:activeCompiler,root:$('panel-host'),onOutput:output=>{if(context.current()&&output.stdout)log(output.stdout.trimEnd());},onError:error=>{if(context.current())log(error.message);}});
      if(!context.current()){created.dispose().catch(()=>{});context.check();}
      desktopCompatibility = created;
    }
    await desktopCompatibility.reset(); context.check();
    if (text === example.original.source) {
      const peBase64 = example.original.peBase64;
      compiled = {success:true,pe:Uint8Array.from(atob(peBase64),c=>c.charCodeAt(0)),peBase64,assemblyName:example.desktopKind==='forms'?'OriginalForms':'OriginalWpf',diagnostics:[],originalReferenceFixture:true};
      log('Loaded the original DLL compiled against Microsoft desktop references; its bytes are unchanged.');
    } else {
      compiled = await activeCompiler.compile(text,{optimization:'release',nullable:'enable',emitPdb:true,includeInspection:true,outputKind:'console',compilerExtensions:[],enableGenerators:false,enableAnalyzers:false}); context.check();
      log('Compiled edited source against the browser desktop compatibility APIs.');
    }
  } else if (example?.kind === 'native-task') {
    const project = await nativeTaskProject(activeCompiler,text); context.check();
    const build = await activeCompiler.buildProject({...project,signal:context.signal}); context.check();
    compiled = build.compileResult || {success:false,diagnostics:build.diagnostics};
  } else if (example?.kind === 'resources' || example?.kind === 'custom-task') {
    const files = example.kind === 'resources' ? resourceProjectFiles(text) : await customTaskProjectFiles(activeCompiler, text); context.check();
    const build = await activeCompiler.buildProject({projectPath:example.kind === 'resources' ? 'ResourceDemo.csproj' : 'TaskDemo.csproj',files,restore:false,signal:context.signal}); context.check();
    compiled = build.compileResult || {success:false,diagnostics:build.diagnostics};
  } else if (example?.kind === 'project') {
    const build = await activeCompiler.buildProject({projectPath:'Demo.csproj',files:projectFiles(text),restore:false,signal:context.signal}); context.check();
    compiled = build.compileResult || {success:false,diagnostics:build.diagnostics};
  } else if (example?.kind === 'dynamic') {
    const fn = await activeCompiler.compileFunction({name:'Multiply',returnType:'long',parameters:[{name:'value',type:'long'},{name:'factor',type:'long'}],body:text}); context.check();
    compiled = fn.assembly || fn;
  } else if ($('backend').value === 'native-wasm') {
    nativeResult = await activeCompiler.compileToWasm(text,{assemblyName:'BrowserWasmProgram',nullable:'enable',includeInspection:true,...extensionOptions}); context.check();
    compiled = nativeResult.assembly;
  } else {
    compiled = await activeCompiler.compile(text, {optimization:'release',nullable:'enable',emitPdb:true,includeInspection:true,...extensionOptions,outputKind:['objects','desktop'].includes(example?.kind) ? 'library' : 'console'}); context.check();
  }
  artifact = compiled;
  $('panel-generated').textContent = (compiled.generatedSources || []).map(g => `// ${g.hintName || g.path || g.name}\n${g.text || g.source || ''}`).join('\n\n') || 'No generated sources for this compilation.';
  compiledVersion = version;
  diagnostics(compiled.diagnostics);
  $('timing').textContent = `${(performance.now() - started).toFixed(0)} ms`;
  if (!compiled.success) { if (compiled.error) log(compiled.error.message); status('Compilation failed'); log('Compilation failed. Select a diagnostic to jump to the source.'); return false; }
  $('dirty').hidden = sourceVersion === version;
  log(`${compiled.originalReferenceFixture?'Loaded':'Emitted'} ${compiled.assemblyName}.dll · ${compiled.pe.length.toLocaleString()} bytes`);
  const model = compiled.inspection || await activeCompiler.inspect(compiled); context.check();
  $('panel-il').textContent = ilText(model);
  if ($('backend').value === 'native-wasm') {
    const result = nativeResult || await activeCompiler.emitWasm(compiled); context.check();
    if (!result.success) {
      diagnostics(result.diagnostics); log(result.error?.message || 'Native WebAssembly compilation failed.');
      $('panel-wasm').textContent = JSON.stringify(result.diagnostics || result.error, null, 2);
      status('Native compilation failed'); controls(); return false;
    }
    showWasm(result); jsSource = '';
    $('panel-js').textContent = 'Select MSIL → JavaScript and compile to generate JavaScript.';
  } else {
  try {
    const result = await activeCompiler.emitJavaScript(compiled, {runtimeImport:'../src/il/runtime.mjs'}); context.check();
    jsSource = result.source;
    $('panel-js').textContent = jsSource;
  } catch (error) {
    context.check();
    jsSource = '';
    $('panel-js').textContent = 'This assembly needs capabilities outside the JavaScript backend. Use .NET WebAssembly to execute it.\n\n' + error.message + '\n\n' + (error.diagnostics ? JSON.stringify(error.diagnostics, null, 2) : '');
  }
  }
  status('Compiled'); controls(); return true;
}
function showWasm(result) {
  wasmArtifact = result;
  $('panel-wasm').textContent = JSON.stringify({format:result.format,bytes:result.bytes.length,exports:result.exports,imports:result.imports,cache:result.cache,timings:result.timings},null,2);
  const t = result.timings;
  log(`Emitted ${result.bytes.length.toLocaleString()} bytes of native WebAssembly · ${result.exports.length} exports · ${result.imports.length} runtime imports`);
  log(`C# + inspection ${(t.csharpMs || 0).toFixed(1)} ms · MSIL → Wasm ${t.emitMs.toFixed(1)} ms${result.cache.emitHit ? ' (cached)' : ''}`);
}
async function operation(action) {
  if (busy) return;
  const context = operationContext();
  busy = true; controls();
  try { await action(context); }
  catch (error) { if (context.current()) { status('Error'); log(error.message); if (error.details) log(JSON.stringify(error.details, null, 2)); } }
  finally { if (context.current()) { busy = false; controls(); } }
}
$('compile').onclick = () => operation(compile);
$('run').onclick = () => operation(async context => {
  const activeCompiler = context.compiler;
  const args = JSON.parse($('arguments').value || '[]');
  const example = examples[Number($('example').value)], backend = $('backend').value, backendLabel = $('backend').selectedOptions[0].text;
  const version = sourceVersion;
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('Program arguments must be a JSON array of strings.');
  if (!artifact?.success || compiledVersion !== version) if (!await compile(context)) return;
  context.check();
  if (sourceVersion !== version) { status('Source changed'); log('The source changed during compilation. Run again to compile the current source.'); return; }
  const runningArtifact = artifact;
  status('Running'); log(`Running on ${backendLabel}…`);
  const started = performance.now();
  let result;
  if (backend === 'native-wasm') {
    if (!wasmArtifact) { const emitted = await activeCompiler.emitWasm(runningArtifact); context.check(); showWasm(emitted); }
    result = await activeCompiler.run(wasmArtifact,{backend,args,timeoutMs:30000}); context.check();
  } else if (example?.kind === 'objects') {
    const handle = await activeCompiler.createObject(runningArtifact.assemblyId, 'Counter', [10]); context.check();
    try {
      await activeCompiler.setProperty(handle, 'Value', 20); context.check();
      result = await activeCompiler.invokeObject(handle, 'Add', [22]); context.check();
      result = {...result,backend:'wasm',stdout:`Counter.Value after managed instance invocation: ${result.result}\n`};
    } finally { if (context.current()) await activeCompiler.releaseObject(handle); }
    context.check();
  } else if (example?.kind === 'dynamic') {
    result = await activeCompiler.invoke(runningArtifact.assemblyId, 'RoslynWeb.Dynamic.Function', 'Multiply', [9007199254740993n,2n]); context.check();
    result = {...result,backend:'wasm',stdout:`Generated function result: ${result.result}\n`};
  } else if (example?.kind === 'desktop-binary') {
    result = await desktopCompatibility.run(runningArtifact,{args,timeoutMs:30000}); context.check(); tab('host');
    if(result.success)log('Original managed event handlers are connected to the browser controls.');
  } else if (example?.kind === 'desktop') {
    if(desktopCompatibility){await desktopCompatibility.dispose();desktopCompatibility=null;context.check();}
    result = await activeCompiler.invoke(runningArtifact.assemblyId, 'DesktopDemo', 'Model', []); context.check();
    if (result.success) { await showDesktop(result.result, runningArtifact.assemblyId, context); context.check(); tab('host'); }
    result = {...result,backend:'wasm',stdout:'Browser controls connected to the managed DesktopDemo class.\n'};
  } else if (example?.kind === 'managed-files') {
    result = await activeCompiler.run(runningArtifact, {backend,args,virtualFiles:{'input.txt':'Hello from JavaScript file input!'},captureVirtualFiles:true,timeoutMs:30000}); context.check();
    if(result.success) for(const [path,bytes] of Object.entries(result.virtualFiles||{})) log(`File ${path}: ${new TextDecoder().decode(bytes)}`);
  } else { result = await activeCompiler.run(runningArtifact, {backend,args,timeoutMs:30000}); context.check(); }
  if (result.stdout) log(result.stdout.trimEnd());
  if (result.stderr) log(result.stderr.trimEnd());
  if (!result.success) { log(`${result.error?.type || 'Error'}: ${result.error?.message || JSON.stringify(result.error)}`); status('Execution failed'); }
  else { status('Finished'); log(`Process exited with code ${result.exitCode ?? 0} · ${result.backend}`); }
  if (result.fallback) log('Auto selected .NET WebAssembly after checking JavaScript compatibility.');
  $('timing').textContent = `Execution ${(performance.now() - started).toFixed(0)} ms`;
});
$('restart').onclick = () => { busy = false; artifact = null; wasmArtifact = null; jsSource = ''; initialize(); };
$('stop').onclick = () => { compiler?.dispose(); busy = false; artifact = null; wasmArtifact = null; jsSource = ''; controls(); log('Worker terminated. Starting a fresh compiler instance…'); initialize(); };
$('clear').onclick = () => { log('', false); diagnostics([]); };
function download(name, bytes, type = 'application/octet-stream') { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([bytes], { type })); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('download').onclick = () => download(artifact.assemblyName + '.dll', artifact.pe);
$('download-wasm').onclick = () => { if(wasmArtifact?.success) download((artifact.assemblyName || 'Program') + '.wasm',wasmArtifact.bytes,'application/wasm'); };
$('download-js').onclick = () => { if (artifact?.success && jsSource) download(artifact.assemblyName + '.mjs', jsSource, 'text/javascript'); };
$('upload').onclick = () => $('file').click();
function recordPackage(label) { const li = document.createElement('li'); li.textContent = label; $('packages').append(li); }
$('file').onchange = () => operation(async context => {
  const activeCompiler = context.compiler;
  for (const file of Array.from($('file').files)) {
    const bytes = new Uint8Array(await file.arrayBuffer()); context.check();
    status(`Loading ${file.name}`);
    if (/\.nupkg$/i.test(file.name)) { const p = await activeCompiler.importPackage(bytes); context.check(); recordPackage(`${p.id} ${p.version}`); for (const warning of p.warnings || []) log(String(warning)); if (p.dependencies?.length) log('This local package declares dependencies. Restore those packages separately before running.'); }
    else { await activeCompiler.addDll(file.name, bytes); context.check(); recordPackage(file.name); }
  }
  artifact = null; wasmArtifact = null; jsSource = ''; status('References loaded'); $('file').value = '';
});
$('restore').onclick = () => operation(async context => {
  const id = $('package-id').value.trim(), version = $('package-version').value.trim();
  if (!id || !version) throw new Error('Enter a NuGet package ID and version.');
  status(`Restoring ${id}`); log(`Restoring ${id} ${version}…`);
  const result = await context.compiler.restore([{ id, version: version.startsWith('[') || version.startsWith('(') ? version : `[${version}]` }], {signal:context.signal}); context.check();
  for (const p of result.packages) recordPackage(`${p.id} ${p.version}`);
  for (const warning of result.warnings || []) log(typeof warning === 'string' ? warning : JSON.stringify(warning));
  artifact = null; wasmArtifact = null; jsSource = ''; status('Package restored'); log('Compile and run to use the restored package.');
});
for (const [index, example] of examples.entries()) { const option = document.createElement('option'); option.value = index; option.textContent = example.name; $('example').append(option); }
function choose() { const e = examples[Number($('example').value)]; source.value = e.source; $('backend').value=e.preferredBackend || 'wasm'; $('example-description').textContent = e.description; dirty(); lines(); tab('source'); if (e.name.includes('NuGet:')) { $('package-id').value = 'Newtonsoft.Json'; $('package-version').value = '13.0.3'; } }
$('example').onchange = choose;
source.oninput = () => { dirty(); lines(); try { localStorage.setItem('roslyn-browser-source', source.value); } catch {} };
source.onscroll = () => { $('line-numbers').scrollTop = source.scrollTop; };
source.onkeyup = position; source.onclick = position;
source.onkeydown = event => {
  if (event.key === 'Tab') { event.preventDefault(); source.setRangeText('    ', source.selectionStart, source.selectionEnd, 'end'); dirty(); lines(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('run').click(); }
};
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => tab(button.dataset.tab);
$('theme').onclick = () => { const light = document.body.classList.toggle('light'); $('theme').textContent = light ? 'Dark theme' : 'Light theme'; };
choose();
try { const saved = localStorage.getItem('roslyn-browser-source'); if (saved) { source.value = saved; lines(); } } catch {}
initialize();

async function showDesktop(model,assemblyId,context) {
  // The controls are a browser host; managed methods own the application behavior.
  const panel=$('panel-host');
  const {BrowserDesktopHost}=await import('../src/hosting/index.js'); context.check();
  desktopHost?.dispose(); panel.replaceChildren();
  // Create host controls using its explicit cross-platform command API.
  const host=new BrowserDesktopHost({root:panel,onEvent:async event=>{
    if(!context.current()||event.id!=='increment'||event.type!=='click')return;
    const response=await context.compiler.invoke(assemblyId,'DesktopDemo','Increment',[value]);
    if(!context.current())return;
    if(!response.success){log(response.error?.message||'Managed event failed');return;}
    value=response.result;host.apply({op:'update',id:'counter',props:{text:String(value)}});
  }});
  desktopHost = host;
  let value=model.value;
  host.apply({op:'create',widget:{id:'window',type:'window',props:{title:model.title,closable:false}}});
  host.apply({op:'create',parent:'window',widget:{id:'counter',type:'label',props:{text:String(value)}}});
  host.apply({op:'create',parent:'window',widget:{id:'increment',type:'button',props:{text:'Increment in C#'}}});
}
