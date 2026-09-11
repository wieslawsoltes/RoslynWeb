import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {readInputBytes, readJsonFile, writeOutput, collectSources, cliError} from './io.mjs';
import {encodeJson, decodeJson} from './codec.mjs';
import {loadProject, writeVirtualFiles} from './projects.mjs';
import {runArtifact} from './artifact-runner.mjs';
import {createRestoreOptions} from './package-cache.mjs';

const registeredImages = new WeakMap();
const many = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const json = value => JSON.stringify(encodeJson(value), null, 2) + '\n';
const text = bytes => new TextDecoder().decode(bytes);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const stem = input => input === '-' ? 'Program' : path.basename(input || 'Program.cs', path.extname(input || 'Program.cs'));

function requireCount(command, positionals, minimum = 1, maximum = minimum) {
  if (positionals.length < minimum || positionals.length > maximum) throw cliError(`${command} expects ${minimum === maximum ? minimum : `${minimum}–${maximum}`} input argument${maximum === 1 ? '' : 's'}.`);
}
function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw cliError(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}
async function objectOptions(file, ctx) {
  if (file === undefined) return {};
  let value = file;
  if (typeof file === 'string') {
    if (file.trimStart().startsWith('{')) {
      try { value = await decodeJson(JSON.parse(file), {cwd: ctx.cwd}); }
      catch (error) { if (error instanceof SyntaxError) throw cliError(`Invalid JSON options: ${error.message}`, 'INVALID_JSON'); throw error; }
    } else value = await readJsonFile(file, ctx.cwd);
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw cliError('Options must be a JSON object.');
  return value;
}
async function inlineArray(value, label, ctx) {
  if (value === undefined) return undefined;
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
  catch (error) { throw cliError(`${label} must contain a JSON array: ${error.message}`); }
  if (!Array.isArray(parsed)) throw cliError(`${label} must contain a JSON array.`);
  return decodeJson(parsed, {cwd: ctx.cwd});
}
export function parsePackage(value) {
  const split = String(value).lastIndexOf('@');
  if (split <= 0 || split === value.length - 1) throw cliError(`Package '${value}' must use ID@VERSION, for example Newtonsoft.Json@13.0.3.`);
  return {id: value.slice(0, split), version: value.slice(split + 1)};
}
function recordImages(compiler, items) {
  const images = registeredImages.get(compiler) || new Map();
  for (const item of items) images.set(item.key || item.name || item.path, item.bytes);
  registeredImages.set(compiler, images);
}

/** Register inputs once per compiler process; sessions then retain these registrations. */
export async function prepareCompiler(compiler, options, ctx) {
  if (options.compilerReferences) await compiler.loadCompilerReferences();
  if (options.taskReferences) await compiler.loadTaskReferences();
  for (const input of many(options.reference)) {
    const bytes = await readInputBytes(input, ctx.cwd);
    await compiler.addDll(path.basename(input), bytes); recordImages(compiler, [{name: input, bytes}]);
  }
  for (const input of many(options.extension)) {
    const bytes = await readInputBytes(input, ctx.cwd);
    await compiler.addAssembly(path.basename(input), bytes);
    await compiler.addCompilerExtension(path.basename(input), bytes);
  }
  for (const input of many(options.nupkg)) {
    const imported = await compiler.importPackage(await readInputBytes(input, ctx.cwd), {targetFramework: options.framework});
    recordImages(compiler, imported.runtimeAssets);
  }
  if (many(options.package).length && ctx.command !== 'restore') {
    const result = await compiler.restore(many(options.package).map(parsePackage), createRestoreOptions(options, ctx));
    recordImages(compiler, result.runtimeAssets);
  }
  return compiler;
}

async function compileOptions(options, ctx, sources, initial = {}) {
  const value = {optimization: 'release', emitPdb: false, ...initial, ...await objectOptions(options.options, ctx)};
  const mapping = {name: 'assemblyName', kind: 'outputKind', optimization: 'optimization', nullable: 'nullable', langVersion: 'languageVersion', unsafe: 'allowUnsafe', checked: 'checkOverflow', warningsAsErrors: 'warningsAsErrors', emitPdb: 'emitPdb'};
  for (const [flag, field] of Object.entries(mapping)) if (options[flag] !== undefined) value[field] = options[flag];
  if (options.kind) enumValue(options.kind, ['console', 'library', 'windows', 'module'], '--kind');
  if (options.optimization) enumValue(options.optimization, ['release', 'debug'], '--optimization');
  if (options.nullable) enumValue(options.nullable, ['enable', 'disable', 'warnings', 'annotations'], '--nullable');
  if (options.define?.length) value.defines = [...(value.defines || []), ...many(options.define)];
  if (options.using?.length) value.usings = [...(value.usings || []), ...many(options.using)];
  if (options.useCompilationCache === false || options.cache === false || options.noCache === true) value.useCompilationCache = false;
  if (typeof options.pdb === 'string') value.emitPdb = true;
  if (options.xml) value.emitXmlDocumentation = true;
  if (!value.assemblyName && sources?.length) value.assemblyName = stem(sources[0].path).replace(/[^A-Za-z0-9_.-]/g, '_') || 'Program';
  return value;
}
async function emitterOptions(backend, options, ctx, base = {}) {
  const value = {...base, ...await objectOptions(backend === 'wasm' ? options.wasmOptions : options.javascriptOptions, ctx)};
  if (backend === 'javascript') value.runtimeImport ??= new URL('../il/index.js', import.meta.url).href;
  if (options.optimize !== undefined) {
    const mode = options.optimize === 'true' ? true : options.optimize === 'false' ? false : options.optimize;
    enumValue(mode, backend === 'wasm' ? [true, false] : [true, false, 'blocks'], '--optimize');
    value.optimize = mode;
  }
  return value;
}
async function executionOptions(options, ctx) {
  const value = {...await objectOptions(options.runOptions, ctx)};
  if (options.backend !== undefined) value.backend = enumValue(options.backend, ['auto', 'wasm', 'javascript', 'native-wasm'], '--backend');
  if (options.args?.length) value.args = options.args;
  if (options.timeoutMs !== undefined) value.timeoutMs = options.timeoutMs;
  if (options.maxInstructions !== undefined) value.maxInstructions = options.maxInstructions;
  if (options.optimize !== undefined) value.optimize = (await emitterOptions('javascript', options, ctx)).optimize;
  if (options.wasmOptions) value.wasm = await emitterOptions('wasm', options, ctx, value.wasm);
  if (options.javascriptOptions) value.javascript = await emitterOptions('javascript', options, ctx, value.javascript);
  if (options.filesOut) value.captureVirtualFiles = true;
  return value;
}
async function finishExecution(result, options, ctx, {showReturn = false} = {}) {
  if (options.filesOut) await writeVirtualFiles(options.filesOut, result.virtualFiles || result.files || {}, ctx);
  if (options.output) await writeOutput(options.output, json(result), ctx.cwd);
  let output = result.stdout || '';
  if (showReturn && result.success !== false && has(result, 'result')) output += (typeof result.result === 'string' ? result.result : JSON.stringify(encodeJson(result.result))) + '\n';
  return {result, output, stderr: result.stderr || '', exitCode: result.success === false ? 1 : result.exitCode ?? 0};
}
async function canonicalPath(input, cwd) {
  let current = path.resolve(cwd, input), suffix = [];
  for (;;) {
    try { return path.join(await realpath(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(cwd, input);
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}
async function validateOutputs(outputs, options, ctx) {
  const inputOptions = ['reference', 'extension', 'nupkg', 'options', 'runOptions', 'wasmOptions', 'javascriptOptions', 'projectOptions', 'spec', 'request'];
  const inputs = [...(ctx.cliInputs || []), ...(ctx.sourceInputs || []), ...inputOptions.flatMap(key => many(options[key]))]
    .filter(input => typeof input === 'string' && input !== '-' && !input.trimStart().startsWith('{'));
  const protectedPaths = new Set(await Promise.all(inputs.map(input => canonicalPath(input, ctx.cwd))));
  const destinations = new Set();
  for (const output of outputs.filter(value => typeof value === 'string')) {
    if (output === '-') throw cliError('Artifact output requires a file path; use --json for structured stdout.');
    const destination = await canonicalPath(output, ctx.cwd);
    if (protectedPaths.has(destination)) throw cliError(`Output would overwrite an input file: ${output}`, 'OUTPUT_PATH');
    if (destinations.has(destination)) throw cliError(`Output paths must be distinct: ${output}`, 'OUTPUT_PATH');
    destinations.add(destination);
  }
}
async function writeCompilation(result, target, options, ctx, defaultName) {
  const outputs = {};
  const extension = target === 'wasm' ? '.wasm' : target === 'javascript' ? '.mjs' : '.dll';
  await validateOutputs([options.output || `${defaultName}${extension}`, options.pdb, options.xml, options.manifest, options.artifact], options, ctx);
  if (result.success !== false) {
    const assembly = result.assembly || result.compileResult || result;
    const content = target === 'wasm' ? result.bytes : target === 'javascript' ? result.source : assembly.pe;
    if (content !== undefined) outputs.output = await writeOutput(options.output || `${defaultName}${extension}`, content, ctx.cwd);
    if (typeof options.pdb === 'string' && assembly.pdb) outputs.pdb = await writeOutput(options.pdb, assembly.pdb, ctx.cwd);
    if (options.xml && assembly.xmlDocumentation !== undefined) outputs.xml = await writeOutput(options.xml, assembly.xmlDocumentation, ctx.cwd);
    if (options.manifest && result.manifest) outputs.manifest = await writeOutput(options.manifest, json(result.manifest), ctx.cwd);
  }
  if (options.artifact) outputs.artifact = await writeOutput(options.artifact, json(result), ctx.cwd);
  return {result: {...result, outputs}, output: Object.values(outputs).map(file => `Wrote ${file}\n`).join(''), exitCode: result.success === false ? 1 : 0};
}
async function modelInput(input, compiler, ctx) {
  if (path.extname(input).toLowerCase() === '.json') {
    const value = await readJsonFile(input, ctx.cwd);
    if (value?.types) return value;
    if (value?.model || value?.inspection) return value.model || value.inspection;
    return compiler.inspect(value);
  }
  return compiler.inspect(await readInputBytes(input, ctx.cwd));
}
function properties(values) {
  const result = {};
  for (const value of many(values)) {
    const index = value.indexOf('=');
    if (index < 1) throw cliError(`Property '${value}' must use NAME=VALUE.`);
    Object.defineProperty(result, value.slice(0, index), {value: value.slice(index + 1), enumerable: true, configurable: true, writable: true});
  }
  return result;
}

/** Command results remain structured; the entry point controls stdout and exit handling. */
export async function executeCommand(command, positionals, options, ctx) {
  ctx = {...ctx, cliInputs: ['eval', 'restore'].includes(command) ? [] : positionals};
  await validateOutputs([options.output, options.pdb, options.xml, options.manifest, options.artifact], options, ctx);
  const emissionTarget = command === 'emit-js' ? 'javascript' : command === 'emit-wasm' ? 'wasm'
    : ['compile', 'build'].includes(command) ? options.target || 'il'
    : command === 'analyze' ? options.backend === 'native-wasm' ? 'wasm' : 'javascript' : undefined;
  if (emissionTarget !== undefined) {
    if (options.wasmOptions && emissionTarget !== 'wasm') throw cliError('--wasm-options requires a native Wasm compilation target.');
    if (options.javascriptOptions && emissionTarget !== 'javascript') throw cliError('--javascript-options requires a JavaScript compilation target.');
    if (options.manifest && emissionTarget !== 'wasm') throw cliError('--manifest requires a native Wasm compilation target.');
    if (options.optimize !== undefined && emissionTarget === 'il') throw cliError('--optimize controls the JavaScript/Wasm backend; use --optimization for C# compilation.');
  }
  if (command === 'run') {
    requireCount(command, positionals, 1, Infinity);
    const runOptions = await executionOptions(options, ctx);
    const extension = path.extname(positionals[0]).toLowerCase();
    if (positionals.length === 1 && ['.wasm', '.mjs', '.js', '.json'].includes(extension)) {
      const input = extension === '.json' ? await readJsonFile(positionals[0], ctx.cwd) : path.resolve(ctx.cwd, positionals[0]);
      const kind = extension === '.wasm' || input?.bytes ? 'wasm' : ['.mjs', '.js'].includes(extension) ? 'javascript' : input?.format === 'javascript' ? 'javascript-artifact' : null;
      if (kind) {
        const backend = kind === 'wasm' ? 'native-wasm' : 'javascript';
        if (runOptions.backend && runOptions.backend !== 'auto' && runOptions.backend !== backend) throw cliError(`This artifact requires --backend ${backend}.`);
        return finishExecution(await runArtifact(input, runOptions, {signal: ctx.signal, kind, timeoutMs: runOptions.timeoutMs ?? 30000}), options, ctx);
      }
      const compiler = await ctx.getCompiler();
      if (input?.compileResult) await registerProjectDependencies(compiler, input);
      return finishExecution(await compiler.run(input?.compileResult || input, {...runOptions, backend: runOptions.backend || 'auto'}), options, ctx);
    }
    const compiler = await ctx.getCompiler();
    let assembly;
    if (positionals.length === 1 && ['.dll', '.exe'].includes(extension)) assembly = await readInputBytes(positionals[0], ctx.cwd);
    else if (positionals.length === 1 && extension === '.csproj') {
      const build = await buildProject(compiler, positionals[0], options, ctx);
      if (!build.success) return {result: build, exitCode: 1};
      assembly = build.compileResult;
    } else {
      const sources = await collectSources(positionals, ctx);
      assembly = await compiler.compile(sources, await compileOptions(options, ctx, sources));
      if (!assembly.success) return {result: assembly, exitCode: 1};
    }
    if (typeof options.pdb === 'string' && assembly.pdb) await writeOutput(options.pdb, assembly.pdb, ctx.cwd);
    if (options.xml && assembly.xmlDocumentation !== undefined) await writeOutput(options.xml, assembly.xmlDocumentation, ctx.cwd);
    return finishExecution(await compiler.run(assembly, {...runOptions, backend: runOptions.backend || 'auto'}), options, ctx);
  }
  if (command === 'native') {
    requireCount(command, positionals);
    const request = {...await objectOptions(options.request, ctx)};
    if (options.args?.length) request.args = options.args;
    return finishExecution(await runArtifact(path.resolve(ctx.cwd, positionals[0]), request, {signal: ctx.signal, kind: 'native', timeoutMs: options.timeoutMs ?? 30000}), options, ctx);
  }
  if (command === 'evaluate-project') {
    requireCount(command, positionals);
    const {evaluateProject} = await import('../projects/index.js');
    const result = evaluateProject(await projectOptions(positionals[0], options, ctx));
    if (options.output) await writeOutput(options.output, json(result), ctx.cwd);
    return {result, exitCode: result.diagnostics?.some(item => item.severity === 'error') ? 1 : 0};
  }
  const compiler = await ctx.getCompiler();
  if (command === 'info') { requireCount(command, positionals, 0); return {result: compiler.info}; }
  if (command === 'references') { requireCount(command, positionals, 0); return {result: await compiler.references()}; }
  if (command === 'extensions') { requireCount(command, positionals, 0); return {result: await compiler.compilerExtensions()}; }
  if (command === 'compile') {
    const sources = await collectSources(positionals, ctx);
    ctx.sourceInputs = sources.map(source => source.path);
    const target = enumValue(options.target || 'il', ['il', 'javascript', 'wasm'], '--target');
    const settings = await compileOptions(options, ctx, sources);
    if (target === 'javascript') settings.javascript = await emitterOptions('javascript', options, ctx, settings.javascript);
    if (target === 'wasm') settings.wasm = await emitterOptions('wasm', options, ctx, settings.wasm);
    const method = target === 'wasm' ? 'compileToWasm' : target === 'javascript' ? 'compileToJavaScript' : 'compile';
    return writeCompilation(await compiler[method](sources, settings), target, options, ctx, stem(sources[0].path));
  }
  if (command === 'emit-js' || command === 'emit-wasm') {
    requireCount(command, positionals);
    const target = command === 'emit-js' ? 'javascript' : 'wasm';
    const input = path.extname(positionals[0]).toLowerCase() === '.json' ? await readJsonFile(positionals[0], ctx.cwd) : await readInputBytes(positionals[0], ctx.cwd);
    const result = await compiler[target === 'wasm' ? 'emitWasm' : 'emitJavaScript'](input, await emitterOptions(target, options, ctx));
    return writeCompilation(result, target, options, ctx, stem(positionals[0]));
  }
  if (command === 'inspect' || command === 'analyze') {
    requireCount(command, positionals);
    const model = await modelInput(positionals[0], compiler, ctx);
    let result = model;
    if (command === 'analyze') {
      const backend = enumValue(options.backend || 'javascript', ['javascript', 'native-wasm'], '--backend');
      const settings = await emitterOptions(backend === 'native-wasm' ? 'wasm' : 'javascript', options, ctx);
      const assemblies = [...(settings.assemblies || [])];
      for (const bytes of registeredImages.get(compiler)?.values() || []) {
        const linked = await compiler.inspect(bytes);
        if (linked.name !== model.name && !assemblies.some(item => item.name === linked.name)) assemblies.push(linked);
      }
      const {AssemblyCompilerHost} = await import('../compiler-cache.mjs');
      const linker = new AssemblyCompilerHost((_method, args) => compiler.inspect(args[0]));
      try {
        const prepared = await linker.prepare({model}, {...settings, assemblies});
        try {
          if (backend === 'native-wasm') { const {analyzeWasmAssembly} = await import('../wasm/index.js'); result = analyzeWasmAssembly(prepared.model, prepared.options); }
          else { const {analyzeAssembly} = await import('../il/index.js'); result = analyzeAssembly(prepared.model, prepared.options); }
        } finally { linker.releasePreparation(prepared); }
      } finally { linker.dispose(); }
    }
    if (options.output) await writeOutput(options.output, json(result), ctx.cwd);
    return {result, exitCode: result.supported === false ? 1 : 0};
  }
  if (command === 'eval' || command === 'compile-function') {
    const spec = {...await objectOptions(options.spec, ctx)};
    if (options.returnType !== undefined) spec.returnType = options.returnType;
    if (options.type !== undefined) spec.typeName = options.type;
    if (options.method !== undefined) spec.name = options.method;
    spec.compileOptions = await compileOptions(options, ctx, undefined, spec.compileOptions);
    if (options.using?.length) spec.usings = [...(spec.usings || ['System']), ...many(options.using)];
    const args = await inlineArray(options.arguments, '--arguments', ctx) || spec.arguments || [];
    if (command === 'eval') {
      requireCount(command, positionals, 1, Infinity);
      return finishExecution(await compiler.evaluate(positionals.join(' '), {...spec, arguments: args}), options, ctx, {showReturn: true});
    }
    if (positionals.length) {
      requireCount(command, positionals);
      spec.body = positionals[0] === '-' ? await ctx.stdinText() : text(await readInputBytes(positionals[0], ctx.cwd));
    }
    const fn = await compiler.compileFunction(spec);
    if (!fn.success) return {result: fn, exitCode: 1};
    if (options.invoke) return finishExecution(await fn.invoke(...args), options, ctx, {showReturn: true});
    return writeCompilation(fn.assembly, 'il', options, ctx, spec.name || 'Function');
  }
  if (command === 'invoke') {
    requireCount(command, positionals);
    if (!options.type || !options.method) throw cliError('invoke requires --type and --method.');
    const settings = await executionOptions(options, ctx);
    if (settings.backend && settings.backend !== 'wasm') throw cliError('invoke uses the managed runtime (--backend wasm). For compiled Wasm exports use the Node loadWasm().invoke() API.');
    const parameterTypes = await inlineArray(options.parameters, '--parameters', ctx);
    const genericArguments = await inlineArray(options.genericArguments, '--generic-arguments', ctx);
    if (parameterTypes) settings.parameterTypes = parameterTypes;
    if (genericArguments) settings.genericArguments = genericArguments;
    const input = Buffer.from(await readInputBytes(positionals[0], ctx.cwd)).toString('base64');
    return finishExecution(await compiler.invoke(input, options.type, options.method, await inlineArray(options.arguments, '--arguments', ctx) || [], settings), options, ctx, {showReturn: true});
  }
  if (command === 'build') {
    requireCount(command, positionals);
    const result = await buildProject(compiler, positionals[0], options, ctx);
    if (options.filesOut) await writeVirtualFiles(options.filesOut, result.generatedFiles, ctx);
    const target = enumValue(options.target || 'il', ['il', 'javascript', 'wasm'], '--target');
    if (result.success && result.compileResult && target !== 'il') {
      const emitted = await compiler[target === 'wasm' ? 'emitWasm' : 'emitJavaScript'](result.compileResult, await emitterOptions(target, options, ctx));
      return writeCompilation({...emitted, project: result, assembly: result.compileResult}, target, options, ctx, stem(positionals[0]));
    }
    return writeCompilation(result, target, options, ctx, stem(positionals[0]));
  }
  if (command === 'restore') {
    const requests = [...positionals, ...many(options.package)].map(parsePackage);
    if (!requests.length) throw cliError('restore requires at least one ID@VERSION package.');
    const result = await compiler.restore(requests, createRestoreOptions(options, ctx));
    if (options.output) await writeOutput(options.output, json(result.lock), ctx.cwd);
    if (options.artifact) await writeOutput(options.artifact, json(result), ctx.cwd);
    if (options.filesOut) await writeVirtualFiles(options.filesOut, new Map(result.packages.flatMap(pkg => [...pkg.files].map(([name, bytes]) => [`${pkg.id}/${pkg.version}/${name}`, bytes]))), ctx);
    return {result};
  }
  if (command === 'package') {
    requireCount(command, positionals);
    const result = await compiler.importPackage(await readInputBytes(positionals[0], ctx.cwd), {targetFramework: options.framework});
    if (options.output) await writeOutput(options.output, json(result), ctx.cwd);
    if (options.artifact) await writeOutput(options.artifact, json(result), ctx.cwd);
    if (options.filesOut) await writeVirtualFiles(options.filesOut, result.files, ctx);
    return {result};
  }
  if (command === 'resources' || command === 'resx') {
    requireCount(command, positionals);
    const input = command === 'resx' ? text(await readInputBytes(positionals[0], ctx.cwd)) : await readJsonFile(positionals[0], ctx.cwd);
    if (command === 'resources' && !Array.isArray(input)) throw cliError('resources expects a JSON array of resource entries.');
    const result = await compiler[command === 'resx' ? 'convertResx' : 'createResources'](input);
    if (result.success) {
      const bytes = result.bytes || new Uint8Array(Buffer.from(result.base64, 'base64'));
      await validateOutputs([options.output || `${stem(positionals[0])}.resources`], options, ctx);
      const output = await writeOutput(options.output || `${stem(positionals[0])}.resources`, bytes, ctx.cwd);
      return {result: {...result, outputs: {output}}, output: `Wrote ${output}\n`, exitCode: 0};
    }
    return {result, exitCode: 1};
  }
  if (command === 'task') {
    requireCount(command, positionals);
    if (!options.type) throw cliError('task requires --type with the managed task type name.');
    const result = await compiler.executeBuildTask(await readInputBytes(positionals[0], ctx.cwd), options.type, await objectOptions(options.request, ctx));
    if (options.filesOut) await writeVirtualFiles(options.filesOut, new Map((result.files || []).map(item => [item.path, new Uint8Array(Buffer.from(item.base64, 'base64'))])), ctx);
    if (options.output) await writeOutput(options.output, json(result), ctx.cwd);
    return {result, output: result.stdout || '', stderr: result.stderr || '', exitCode: result.success ? 0 : 1};
  }
  throw cliError(`Unknown command: ${command}. Use roslynweb help.`);
}

async function projectOptions(input, options, ctx) {
  const additional = await objectOptions(options.projectOptions, ctx);
  const mounted = await loadProject(input, {...ctx, root: options.root});
  const result = {...additional, ...mounted, signal: ctx.signal,
    properties: {...additional.properties, ...properties(options.property)},
    restoreOptions: createRestoreOptions({...options, restoreOptions: additional.restoreOptions}, ctx)};
  if (options.targetName?.length) result.targets = many(options.targetName);
  if (options.restore !== undefined) result.restore = options.restore;
  if (options.framework) result.properties.TargetFramework = options.framework;
  if (additional.files) for (const [name, value] of additional.files instanceof Map ? additional.files : Object.entries(additional.files)) result.files.set(name, value);
  return result;
}

async function buildProject(compiler, input, options, ctx) {
  const overrides = await compileOptions(options, ctx);
  const supplied = await objectOptions(options.options, ctx);
  if (options.optimization === undefined && supplied.optimization === undefined) delete overrides.optimization;
  if (options.pdb === undefined && options.emitPdb === undefined && supplied.emitPdb === undefined) delete overrides.emitPdb;
  const {buildProject: build} = await import('../projects/index.js');
  return build({...compiler, compile(sources, projectSettings) {
    return compiler.compile(sources, {...projectSettings, ...overrides,
      ...(overrides.defines ? {defines: [...new Set([...(projectSettings.defines || []), ...overrides.defines])]} : {})});
  }}, await projectOptions(input, options, ctx));
}

async function registerProjectDependencies(compiler, project) {
  for (const dependency of project.projectReferences || []) {
    await registerProjectDependencies(compiler, dependency);
    const assembly = dependency.compileResult;
    if (assembly?.pe) await compiler.addDll(`${assembly.assemblyName || 'Dependency'}.dll`, assembly.pe);
  }
  if (project.packages) await compiler.loadPackages(project.packages);
  for (const satellite of project.satelliteAssemblies || []) await compiler.addAssembly(satellite.path || `${satellite.culture}/${satellite.name}.dll`, satellite.pe);
}
