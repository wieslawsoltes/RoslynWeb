/** C# IL to directly executable WebAssembly, plus the portable module loader. */
export { compileWasm } from './compiler.mjs';
export { analyzeWasmAssembly, analyzeWasmAssembly as analyzeWasm } from './analysis.mjs';
export { loadWasm, NativeWasmError, WASM_MANIFEST_SECTION, clearWasmModuleCache, wasmModuleCacheStats } from './runtime.mjs';
