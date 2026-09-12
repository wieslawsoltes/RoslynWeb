export type WasmValueType = 'i32' | 'i64' | 'f32' | 'f64' | 'externref';
export interface WasmDiagnostic { severity: 'error' | 'warning' | 'info'; code: string; message: string; method?: string; offset?: number; opcode?: string; }
export interface WasmAnalysis {
  supported: boolean;
  diagnostics: WasmDiagnostic[];
  [key: string]: unknown;
}
export interface WasmMethodSelector { token?: number; type?: string; declaringType?: string; name?: string; method?: string; parameters?: string[]; genericArguments?: string[]; }
export interface WasmCompileOptions {
  /** Optimize reducible control flow, native intrinsics and local instructions (default true). */
  optimize?: boolean;
  /** Methods to export; selecting roots compiles their reachable managed dependencies. */
  exports?: Array<string | number | WasmMethodSelector>;
  /** Limit closed managed method specialization (default 4096). */
  maxMethods?: number;
  /** Set false only when the embedding host provides another execution limit. */
  instructionBudget?: boolean;
  /** Validate emitted native bytes (default true). */
  validate?: boolean;
  /** Additional normalized assembly inspection models to link. */
  assemblies?: unknown[];
  /** Native IL basic-block budget, reset for each outer managed invocation. */
  maxInstructions?: number;
  [key: string]: unknown;
}
export interface WasmMethod {
  exportName: string;
  token: number;
  key: string;
  type: string;
  name: string;
  isStatic: boolean;
  parameters: string[];
  returnType: string;
  /** Effective CLR primitive types for enum scalars. Original signatures stay in parameters/returnType. */
  scalarParameters?: string[];
  scalarReturnType?: string;
  wasmParameters: WasmValueType[];
  wasmResult: WasmValueType | null;
  assemblyName?: string;
}
export interface WasmServiceImport {
  name: string;
  kind: string;
  operand?: unknown;
  parameters: WasmValueType[];
  result: WasmValueType | null;
  parameterTypes?: string[];
  returnType?: string;
  [key: string]: unknown;
}
export interface WasmManifest {
  formatVersion: 1;
  assemblyName?: string;
  methods: WasmMethod[];
  imports: WasmServiceImport[];
  entryPointToken?: number | string | null;
  /** Metadata only: generated modules do not embed executable IL bodies. */
  model?: unknown;
  [key: string]: unknown;
}
export interface WasmOptimizationStats {
  enabled: boolean;
  structuredMethods: number;
  dispatcherMethods: number;
  nativeLoops: number;
  directBranches: number;
  eliminatedDispatches: number;
  localTeeRewrites: number;
  intrinsicCalls: number;
  functionBodyBytes: number;
}
export interface WasmCompilation {
  bytes: Uint8Array;
  exports: WasmMethod[];
  imports: WasmServiceImport[];
  manifest: WasmManifest;
  analysis: WasmAnalysis;
  timings: Record<string, number>;
  optimization: WasmOptimizationStats;
  [key: string]: unknown;
}
export interface WasmLoadOptions {
  /** Virtual managed environment identity. UserName defaults to "Browser"; no host OS identity is read. */
  environment?: {userName?: string};
  /** Reuse a bounded cache of native compiled WebAssembly modules (default true). */
  cache?: boolean;
  /** Maximum executed IL instructions, counted at native basic-block boundaries. Default 10,000,000. */
  maxInstructions?: number;
  /** Limit runtime-mediated callbacks; direct Wasm calls use the engine stack and native instruction budget. */
  maxCallDepth?: number;
  maxArrayLength?: number;
  /** Synchronous managed host overrides. A Promise cannot be returned to native IL. */
  externals?: Record<string, Function | {invoke: Function; raw?: boolean}>;
  output?: (text: string, metadata?: {newline?: boolean}) => void;
  signal?: AbortSignal;
  virtualFiles?: Record<string, string | Uint8Array | number[]>;
  captureVirtualFiles?: boolean;
  maxVirtualFileBytes?: number;
  workingDirectory?: string;
}
/** Mutable reference box accepted for exported CLR ref/out parameters. */
export interface WasmRef<T = unknown> { value: T; }
export interface WasmInvokeOptions {
  self?: unknown;
  parameterTypes?: string[];
  assembly?: string;
}
export interface NativeWasmExecutionResult {
  success: boolean;
  backend: 'native-wasm';
  result?: unknown;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: {type: string; message: string; code?: string; details?: unknown};
  virtualFiles?: Record<string, Uint8Array>;
}
export interface WasmExecutable {
  readonly module: WebAssembly.Module;
  readonly instance: WebAssembly.Instance;
  /** Actual native Wasm exports. Low-level callers manage their own argument ABI and execution budget. */
  readonly exports: WebAssembly.Exports;
  readonly manifest: WasmManifest;
  readonly stdout: string;
  readonly stderr: string;
  readonly stats: {cacheHit: boolean; nativeCompilationMs: number; instantiationMs: number; methodCount: number; importCount: number};
  /** Executes native Wasm synchronously. Int64/UInt64 preserve BigInt precision. Decimal arguments accept exact decimal strings or BigInt and results are exact strings. Nullable accepts/returns null or its inner value. ValueTuple accepts fixed-length arrays or ItemN/Rest records and returns arrays. */
  invoke(selector: string | number | {token?: number; name?: string; type?: string; declaringType?: string; parameters?: string[]}, args?: unknown[], options?: WasmInvokeOptions): unknown;
  run(args?: string[], options?: WasmInvokeOptions & {entryPoint?: string | number}): NativeWasmExecutionResult;
  /** Invalidates managed wrappers and releases their runtime state. Previously retained raw exports remain ordinary Wasm functions. */
  dispose(): void;
}
export class NativeWasmError extends Error { code: string; details?: unknown; }
export const WASM_MANIFEST_SECTION: 'roslyn.web.manifest';
export function compileWasm(model: unknown, options?: WasmCompileOptions): WasmCompilation;
export function analyzeWasmAssembly(model: unknown, options?: WasmCompileOptions): WasmAnalysis;
/** Load standalone generated Wasm bytes without Roslyn or the .NET WebAssembly runtime. */
export function loadWasm(input: Uint8Array | ArrayBuffer | ArrayBufferView | WebAssembly.Module | {bytes: Uint8Array}, options?: WasmLoadOptions): Promise<WasmExecutable>;
export function clearWasmModuleCache(): void;
export function wasmModuleCacheStats(): {entries: number; bytes: number; maxEntries: number; maxBytes: number};

export { analyzeWasmAssembly as analyzeWasm };
