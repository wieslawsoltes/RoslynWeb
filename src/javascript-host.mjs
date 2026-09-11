import {AssemblyCompilerHost, copy, retainedBytes} from './compiler-cache.mjs';
import {fromBase64, RoslynError} from './bytes.js';
import {compileJavaScriptModule, analyzeAssembly} from './il/compiler.mjs';
import {executeJavaScript} from './execution.js';

const now = () => performance.now();
/** Compiled functions stay in their Worker. Each execution gets independent CLR state. */
export class JavaScriptCompilerHost extends AssemblyCompilerHost {
  constructor(callManaged, images) {
    super(callManaged, images); this.modules = new Map(); this.sources = new Map(); this.bytes = 0;
  }
  touch(key) {
    const item = this.modules.get(key);
    if (item) { this.modules.delete(key); this.modules.set(key, item); }
    return item;
  }
  trim() {
    while (this.modules.size > 16 || this.bytes > 64 * 1024 * 1024) {
      const key = this.modules.keys().next().value, item = this.modules.get(key);
      this.modules.delete(key); this.bytes -= item.size;
      if (item.source) this.sources.delete(item.source);
    }
  }
  rememberSource(item, source) {
    if (item.source || !this.modules.has(item.key)) return;
    item.source = source; item.size += source.length * 2; this.bytes += source.length * 2;
    this.sources.set(source,item.key); this.trim();
  }
  async factory(input, options = {}) {
    const prepared = await this.prepare(input, {...options,optimize:options.optimize??true,strict:options.strict??true});
    const started = now(); let item = this.touch(prepared.key), moduleHit = !!item;
    if (!item) {
      const module = compileJavaScriptModule(prepared.model, prepared.options);
      item = {module, options:prepared.options, key:prepared.key,
        size:prepared.key.length * 2 + module.generatedSourceBytes + retainedBytes([module.model,...module.linked.map(item=>item.model)])};
      this.modules.set(prepared.key,item); this.bytes += item.size; this.trim();
    }
    return {item, moduleHit, prepared, timings:{...prepared.timings, javascriptMs:now()-started,totalMs:now()-prepared.start}};
  }
  async analyze(input, options = {}) {
    const prepared = await this.prepare(input,options);
    return analyzeAssembly(prepared.model,prepared.options);
  }
  async emit(input, options = {}) {
    const result = await this.factory(input,options), {item} = result;
    const start = now(), source = item.module.source;
    this.rememberSource(item,source);
    const {assemblies:_assemblies,...javascriptOptions} = item.options;
    return {format:'javascript',success:true,source,model:copy(item.module.model),assemblies:copy(item.module.linked.map(item=>item.model)),
      analysis:copy(item.module.analysis),optimization:copy(item.module.optimization),javascriptOptions:copy(javascriptOptions),
      cache:{emitHit:result.moduleHit},timings:{...result.timings,sourceMs:now()-start,totalMs:now()-result.prepared.start}};
  }
  async compile(request, options) {
    const started = now(), assembly = await this.callManaged('Compile',[JSON.stringify({...request,includeInspection:!!request.includeInspection})]);
    const csharpMs = now()-started;
    if (!assembly.success) return {success:false,stage:'csharp',assembly,diagnostics:assembly.diagnostics,error:assembly.error,timings:{csharpMs,totalMs:now()-started}};
    if (assembly.peBase64) assembly.pe = fromBase64(assembly.peBase64);
    if (assembly.pdbBase64) assembly.pdb = fromBase64(assembly.pdbBase64);
    this.rememberInspection(assembly.peBase64,assembly.inspection);
    if (!request.includeInspection) delete assembly.inspection;
    try {
      const artifact = await this.emit({peBase64:assembly.peBase64},options);
      return {...artifact,assembly,timings:{...artifact.timings,csharpMs,totalMs:now()-started}};
    } catch (error) {
      if (error.name !== 'ILCompilationError' && !error.code?.startsWith('WASM_')) throw error;
      return {success:false,stage:'javascript',assembly,diagnostics:error.diagnostics || [],error:{type:error.name,code:error.code || 'JAVASCRIPT_UNSUPPORTED',message:error.message},timings:{csharpMs,totalMs:now()-started}};
    }
  }
  async run(input, options = {}) {
    const started = now(); let prepared, item, moduleHit = false;
    if (input.format === 'javascript') {
      item = this.touch(this.sources.get(input.source)); moduleHit = !!item;
      if (!item) {
        prepared = await this.factory({model:input.model},{...input.javascriptOptions,assemblies:input.assemblies}); item = prepared.item; moduleHit = prepared.moduleHit;
        // The exported source identifies the code being run. Edited source must be
        // imported as an ES module; it cannot silently execute a different IL model.
        if (item.module.source !== input.source) throw new RoslynError('JavaScript artifact source does not match its compiled model and options. Import edited source as an ES module.', 'JAVASCRIPT_ARTIFACT_CHANGED');
        this.rememberSource(item,input.source);
      }
    } else {
      prepared = await this.factory(input,{...options.javascript,optimize:options.optimize ?? options.javascript?.optimize,assemblies:options.assemblies ?? options.javascript?.assemblies});
      item = prepared.item; moduleHit = prepared.moduleHit;
    }
    const executed = await executeJavaScript(item.module.model,options,item.module);
    return {...executed,analysis:copy(executed.analysis),optimization:copy(item.module.optimization),cache:{moduleHit},timings:{...prepared?.timings,totalMs:now()-started}};
  }
  async tryRun(input,options = {}) {
    const analysis = await this.analyze(input,{assemblies:options.assemblies ?? options.javascript?.assemblies});
    if (!analysis.supported || analysis.dependencies?.some(dependency=>dependency.overloadValidatedAtRuntime)) return {selected:false,analysis};
    return {selected:true,result:await this.run(input,options)};
  }
  call(operation,args) {
    if (!['compile','emit','run','analyze','tryRun'].includes(operation)) throw new TypeError(`Unknown JavaScript compiler operation: ${operation}`);
    return this[operation](...args);
  }
  dispose() { super.dispose(); this.modules.clear(); this.sources.clear(); this.bytes = 0; }
}
