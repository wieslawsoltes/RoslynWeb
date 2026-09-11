import { fromBase64 } from '../bytes.js';
import { compileWasm } from './compiler.mjs';
import { loadWasm } from './runtime.mjs';
import {AssemblyCompilerHost, BoundedCache} from '../compiler-cache.mjs';
export {rememberAssembly} from '../compiler-cache.mjs';
const now = () => performance.now();

export class NativeWasmHost extends AssemblyCompilerHost {
  constructor(callManaged, images) { super(callManaged, images); this.emissions = new BoundedCache(); }
  async emit(input, options = {}) {
    const prepared = await this.prepare(input, options);
    const {model, options:effective, key, start} = prepared;
    const linked = now();
    let artifact = this.emissions.get(key), emitHit = !!artifact;
    if (!artifact) { artifact = compileWasm(model, effective); this.emissions.set(key, artifact); }
    const end = now();
    return {...artifact, format: 'wasm', success: true, cache: {emitHit}, timings: {
      ...artifact.timings, ...(emitHit ? {analysisMs: 0, emissionMs: 0} : {}),
      ...prepared.timings, emitMs: end - linked, totalMs: end - start
    }};
  }
  async compile(request, options) {
    const start = now();
    const assembly = await this.callManaged('Compile', [JSON.stringify({...request, includeInspection: !!request.includeInspection})]);
    const csharpMs = now() - start;
    if (!assembly.success) return {success: false, stage: 'csharp', assembly, diagnostics: assembly.diagnostics, error: assembly.error, timings: {csharpMs, totalMs: now() - start}};
    if (assembly.peBase64) assembly.pe = fromBase64(assembly.peBase64);
    if (assembly.pdbBase64) assembly.pdb = fromBase64(assembly.pdbBase64);
    const model = assembly.inspection;
    this.rememberInspection(assembly.peBase64, model);
    if (!request.includeInspection) delete assembly.inspection;
    try {
      const artifact = await this.emit({peBase64: assembly.peBase64}, options);
      return {...artifact, assembly, timings: {...artifact.timings, csharpMs, totalMs: now() - start}};
    } catch (error) {
      if (!error.code?.startsWith('WASM_')) throw error;
      return {success: false, stage: 'wasm', assembly, diagnostics: error.diagnostics || error.details?.diagnostics || [],
        error: {type: error.name, code: error.code, message: error.message}, timings: {csharpMs, totalMs: now() - start}};
    }
  }
  async run(input, options = {}) {
    const start = now();
    const artifact = input.bytes ? input : await this.emit(input, options.wasm || {assemblies: options.assemblies});
    const program = await loadWasm(artifact.bytes, options);
    try {
      const result = program.run(options.args || [], options);
      return {...result, cache: {...artifact.cache, moduleHit: program.stats.cacheHit},
        timings: {...artifact.timings, ...program.stats, totalMs: now() - start}};
    } finally { program.dispose(); }
  }
  call(operation, args) {
    if (!['compile', 'emit', 'run'].includes(operation)) throw new TypeError(`Unknown native Wasm operation: ${operation}`);
    return this[operation](...args);
  }
  dispose() { super.dispose(); this.emissions.clear(); }
}
