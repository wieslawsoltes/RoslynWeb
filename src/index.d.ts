import type {WasmCompilation, WasmCompileOptions, WasmDiagnostic} from './wasm/index.js';
import type {JavaScriptCompileOptions, JavaScriptOptimization, JavaScriptOptimizationStats, ILAnalysis, ILDiagnostic} from './il/index.js';
export type {JavaScriptCompileOptions, JavaScriptOptimization, JavaScriptOptimizationStats, JavaScriptCompiledModule, JavaScriptRuntimeOptions, ILAnalysis, ILDiagnostic} from './il/index.js';
export type * from './wasm/index.js';
export { NuGetResolver, importNupkg } from './packages/index.js';
import type { PackageResolution, ImportedPackage, NuGetResolverOptions, PackageRequest, PackageImportOptions } from './packages/index.js';
import type { ProjectOptions, ProjectBuildResult, ProjectEvaluation } from './projects/index.js';
import type { WasmCommandRequest, WasmCommandResult } from './hosting/index.js';
export type Bytes = Uint8Array | ArrayBuffer | ArrayBufferView;
export interface SourceFile { path: string; text: string }
export interface Diagnostic { id: string; severity: 'error'|'warning'|'info'|'hidden'; message: string; path: string; startLine: number; startColumn: number; endLine: number; endColumn: number; warningLevel?: number }
export interface CompileOptions {
  /** Reuse bounded parsed syntax trees and base compilations. Defaults to true. */
  useCompilationCache?: boolean;
  assemblyName?: string;
  outputKind?: 'console'|'library'|'windows'|'module';
  languageVersion?: string;
  optimization?: 'debug'|'release';
  nullable?: 'enable'|'disable'|'warnings'|'annotations';
  allowUnsafe?: boolean;
  checkOverflow?: boolean;
  deterministic?: boolean;
  warningsAsErrors?: boolean;
  warningLevel?: number;
  mainTypeName?: string;
  defines?: string[];
  usings?: string[];
  referenceNames?: string[];
  emitPdb?: boolean;
  emitXmlDocumentation?: boolean;
  includeInspection?: boolean;
  resources?: EmbeddedResource[];
  compilerExtensions?: string[];
  enableGenerators?: boolean;
  enableAnalyzers?: boolean;
  additionalTexts?: SourceFile[];
  analyzerOptions?: { globalOptions?: Record<string,string>; fileOptions?: Record<string,Record<string,string>> };
  analyzerConfigFiles?: SourceFile[];
}
export interface CompileRequest extends CompileOptions { sources: SourceFile[] }
export interface ManagedError { type: string; message: string; stack?: string }
export interface AssemblyModel { name: string; types: Array<Record<string, unknown>>; [key: string]: unknown }
export interface CompilationResult {
  success: boolean;
  assemblyId?: string;
  assemblyName?: string;
  pe?: Uint8Array;
  pdb?: Uint8Array;
  peBase64?: string;
  pdbBase64?: string;
  diagnostics?: Diagnostic[];
  inspection?: AssemblyModel;
  xmlDocumentation?: string;
  error?: ManagedError;
  performance?: {parseMs:number; compilationMs:number; extensionsMs:number; emitMs:number; cache:{enabled:boolean; syntaxHits:number; incrementalParses:number; syntaxMisses:number; compilationReused:boolean; retainedTrees:number; retainedSourceBytes:number; maxRetainedTrees:number; maxRetainedSourceBytes:number}};
  elapsedMs: number;
  generatedSources?: Array<{ hintName: string; path?: string; text: string; generator?: string }>;
  generatorDiagnostics?: Diagnostic[];
  analyzerDiagnostics?: Diagnostic[];
  compilerExtensionsReport?: Record<string,unknown>;
}
export type AssemblyInput = CompilationResult | Bytes | string;
export type JavaScriptExternal = ((...args:any[])=>any) | {raw:true;invoke(context:any):any};
export type FileInputs = Record<string,string|Uint8Array|number[]>;
export interface ExecutionFileOptions {
  /** Seed files. WASM requires paths relative to its workspace; JavaScript uses virtual root paths. */
  virtualFiles?: FileInputs;
  /** Return copied file bytes. Defaults to true for managed file operations, false for JavaScript. */
  captureVirtualFiles?: boolean;
  /** Aggregate transferred/snapshotted bytes (WASM) or filesystem bytes (JavaScript). Default 16 MiB. */
  maxVirtualFileBytes?: number;
  /** Managed workspace limit. Auto mode selects WASM when provided. */
  maxVirtualFileCount?: number;
  /** Persistent managed workspace from createWorkspace(). Auto mode selects WASM. */
  workspaceId?: string;
  /** Workspace-relative current directory for WASM; virtual directory for JavaScript. */
  workingDirectory?: string;
  /** Relative managed workspace files to delete before execution. */
  removedFiles?: string[];
}
export interface ExecutionOptions extends ExecutionFileOptions {
  backend?: 'wasm'|'javascript'|'auto'|'native-wasm';
  wasm?: WasmCompileOptions;
  javascript?: JavaScriptEmitOptions;
  optimize?: JavaScriptOptimization;
  entryPoint?: string|number;
  args?: string[];
  timeoutMs?: number;
  maxInstructions?: number;
  maxSteps?: number;
  externals?: Record<string, JavaScriptExternal> | Map<string, JavaScriptExternal>;
  assemblies?: AssemblyModel[];
}
export interface ExecutionResult {
  success: boolean; backend?: 'wasm'|'javascript'|'native-wasm'; result?: unknown; exitCode: number;
  stdout: string; stderr: string; error?: ManagedError; elapsedMs?: number;
  timings?: Record<string,number|boolean>; cache?: {emitHit?:boolean;moduleHit?:boolean};
  optimization?: JavaScriptOptimizationStats;
  analysis?: unknown; fallback?: unknown; virtualFiles?: Record<string,Uint8Array>;
  files?: Record<string,Uint8Array>; changedFiles?: Record<string,Uint8Array>; removedFiles?: string[]; workspaceId?:string; fileBytes?:number;
}
export interface WorkspaceOptions { files?:FileInputs; maxFileBytes?:number; maxFileCount?:number }
export interface WorkspaceResult { success:true; workspaceId:string; files?:Record<string,Uint8Array>|null; entries?:Array<{path:string;bytes:number}>; byteCount?:number; maxFileBytes?:number; maxFileCount?:number; disposed?:boolean }
export interface CompilerInfo { bridgeVersion: string; roslynVersion: string; runtimeVersion: string; referenceCount: number; execution: string }
export interface CompilerEvent { type: string; stage?: string; message?: string; text?: string; [key: string]: unknown }
export interface RoslynOptions {
  /** Abort startup and compiler lifetime. Workers are terminated; worker:false rejects pending calls and disables later calls but cannot interrupt managed code already executing in the caller's realm. */
  signal?: AbortSignal;
  baseUrl?: string|URL; worker?: boolean; workerUrl?: string|URL;
  /** Optional Web Worker constructor for host adapters; does not alter globalThis.Worker. */
  Worker?: typeof Worker;
  timeoutMs?: number; startupTimeoutMs?: number; config?: Record<string,unknown>;
  onEvent?: (event: CompilerEvent) => void;
}
export interface ReferenceInfo { name: string; fileName: string; userSupplied: boolean }
export interface Registration { success: boolean; name: string; assemblyName: string; bytes: number }
export interface ObjectHandle { $handle: string; typeName: string }
export interface InvocationOptions { parameterTypes?: string[]; genericArguments?: string[]; returnHandle?: boolean; includeArguments?: boolean }
export interface ManagedInvocationOptions extends InvocationOptions, ExecutionFileOptions { timeoutMs?:number }
export interface FunctionSpec { name?: string; typeName?: string; assemblyName?: string; returnType?: string; parameters?: Array<{name:string;type:string}>; usings?: string[]; body?: string; compileOptions?: CompileOptions }
export interface CompiledFunction { success:true; assembly:CompilationResult; source:string; typeName:string; methodName:string; invoke(...args:unknown[]):Promise<ExecutionResult> }
export interface ResourceEntry { name:string; type?:string; value:unknown }
export interface EmbeddedResource { name:string; isPublic?:boolean; base64?:string; resx?:string; entries?:ResourceEntry[] }
export interface ResourceResult { success:boolean; base64?:string; bytes?:Uint8Array; diagnostics?:Diagnostic[]; error?:ManagedError }
export interface BuildTaskRequest { parameters?:Record<string,unknown>; files?:Array<{path:string;base64:string}>; workingDirectory?:string; virtualPaths?:boolean; outputProperties?:string[]; maxFileBytes?:number }
export interface BuildTaskResult { success:boolean; outputs?:Record<string,unknown>; diagnostics?:Array<Record<string,unknown>>; files?:Array<{path:string;base64:string}>; removedFiles?:string[]; stdout?:string; stderr?:string; error?:ManagedError }
export interface NativeWasmArtifact extends WasmCompilation {
  format:'wasm'; success:true; assembly?:CompilationResult;
  cache:{emitHit:boolean};
}
export interface NativeWasmCompilationFailure {
  success:false; stage:'csharp'|'wasm'; assembly:CompilationResult;
  diagnostics?:Array<Diagnostic|WasmDiagnostic>; error?:{type:string;code?:string;message:string}; timings:Record<string,number>;
}
export interface CompileToWasmOptions extends CompileOptions { wasm?:WasmCompileOptions }
/** Worker emission options must be serializable; supply JavaScript externals to run(). */
export interface JavaScriptEmitOptions {
  /** Restrict generated methods and strict diagnostics to a conservative export closure. */
  exports?:JavaScriptCompileOptions['exports'];
  optimize?:JavaScriptOptimization;strict?:boolean;runtimeImport?:string;assemblies?:AssemblyModel[];
}
export interface CompileToJavaScriptOptions extends CompileOptions {javascript?:JavaScriptEmitOptions}
export interface JavaScriptArtifact {
  format:'javascript';success:true;source:string;model:AssemblyModel;assemblies:AssemblyModel[];
  assembly?:CompilationResult;analysis:ILAnalysis;optimization:JavaScriptOptimizationStats;
  javascriptOptions:JavaScriptEmitOptions;cache:{emitHit:boolean};timings:Record<string,number>;
}
export interface JavaScriptCompilationFailure {
  success:false;stage:'csharp'|'javascript';assembly:CompilationResult;
  diagnostics?:Array<Diagnostic|ILDiagnostic>;error?:{type:string;code?:string;message:string};timings:Record<string,number>;
}
export interface RoslynCompiler {
  readonly info: CompilerInfo;
  readonly disposed: boolean;
  onEvent(listener: (event: CompilerEvent) => void): () => void;
  compile(source: string|SourceFile[]|CompileRequest, options?: CompileOptions): Promise<CompilationResult>;
  /** C# → real PE/MSIL → native Wasm, inside the compiler Worker. Defaults to release/no PDB. */
  compileToWasm(source:string|SourceFile[]|CompileRequest, options?:CompileToWasmOptions):Promise<NativeWasmArtifact|NativeWasmCompilationFailure>;
  /** C# → real PE/MSIL → reusable JavaScript ES module inside the compiler Worker. Defaults to release/no PDB. */
  compileToJavaScript(source:string|SourceFile[]|CompileRequest,options?:CompileToJavaScriptOptions):Promise<JavaScriptArtifact|JavaScriptCompilationFailure>;
  /** Compile an existing PE/MSIL image. Unsupported instructions produce explicit diagnostics. */
  emitWasm(assembly:AssemblyInput|AssemblyModel, options?:WasmCompileOptions):Promise<NativeWasmArtifact>;
  addReference(name: string, bytes: Bytes): Promise<Registration>;
  addAssembly(name: string, bytes: Bytes): Promise<Registration>;
  addDll(name: string, bytes: Bytes): Promise<{reference: Registration; assembly: Registration}>;
  addCompilerExtension(name: string, bytes: Bytes): Promise<Record<string,unknown>>;
  compilerExtensions(): Promise<Array<Record<string,unknown>>>;
  loadCompilerReferences(): Promise<string[]>;
  loadTaskReferences(): Promise<string[]>;
  executeBuildTask(assembly:AssemblyInput,typeName:string,request?:BuildTaskRequest):Promise<BuildTaskResult>;
  createWorkspace(options?:WorkspaceOptions):Promise<WorkspaceResult>;
  readWorkspace(workspaceId:string,paths?:string[]):Promise<WorkspaceResult>;
  writeWorkspace(workspaceId:string,files:FileInputs,removedFiles?:string[]):Promise<WorkspaceResult>;
  listWorkspace(workspaceId:string):Promise<WorkspaceResult>;
  deleteWorkspaceFiles(workspaceId:string,paths:string[]):Promise<WorkspaceResult>;
  disposeWorkspace(workspaceId:string):Promise<WorkspaceResult>;
  addNativeCommand(name:string,source:Bytes|WebAssembly.Module|string|URL,options?:{signal?:AbortSignal;timeoutMs?:number}):Promise<{name:string;imports:string[]}>;
  /** A timeout/abort terminates the compiler Worker and all its state. Direct mode cannot interrupt synchronous native code. */
  runNativeCommand(name:string,request?:WasmCommandRequest & {timeoutMs?:number}):Promise<WasmCommandResult>;
  removeNativeCommand(name:string):Promise<boolean>;
  createResources(entries:ResourceEntry[]):Promise<ResourceResult>;
  convertResx(xml:string):Promise<ResourceResult>;
  buildProject(options: ProjectOptions): Promise<ProjectBuildResult>;
  evaluateProject(options: ProjectOptions): Promise<ProjectEvaluation>;
  references(): Promise<ReferenceInfo[]>;
  inspect(assembly: AssemblyInput): Promise<AssemblyModel>;
  restore(packages: PackageRequest[], options?: NuGetResolverOptions & {resolver?: unknown}): Promise<PackageResolution>;
  importPackage(bytes: Bytes, options?: PackageImportOptions): Promise<ImportedPackage>;
  loadPackages(packages: PackageResolution|ImportedPackage): Promise<PackageResolution|ImportedPackage>;
  run(assembly: AssemblyInput|NativeWasmArtifact|JavaScriptArtifact, options?: ExecutionOptions): Promise<ExecutionResult>;
  invoke(assemblyIdOrBase64: string, typeName: string, methodName: string, args?: unknown[], options?: ManagedInvocationOptions): Promise<ExecutionResult>;
  createObject(assemblyIdOrBase64:string,typeName:string,args?:unknown[],options?:InvocationOptions):Promise<ObjectHandle>;
  invokeObject(handle:ObjectHandle|string,methodName:string,args?:unknown[],options?:InvocationOptions):Promise<ExecutionResult>;
  getProperty(handle:ObjectHandle|string,name:string):Promise<unknown>;
  setProperty(handle:ObjectHandle|string,name:string,value:unknown):Promise<ExecutionResult>;
  releaseObject(handle:ObjectHandle|string):Promise<{success:boolean}>;
  compileFunction(spec:FunctionSpec):Promise<CompiledFunction|CompilationResult>;
  evaluate(expression:string,options?:FunctionSpec & {arguments?:unknown[]}):Promise<ExecutionResult|CompilationResult>;
  emitJavaScript(assembly: AssemblyInput|AssemblyModel, options?: JavaScriptEmitOptions): Promise<JavaScriptArtifact>;
  dispose(): void;
}
export class RoslynError extends Error { diagnostics?: Array<Diagnostic|WasmDiagnostic|ILDiagnostic>; code: string; details?: unknown }
export function createRoslyn(options?: RoslynOptions): Promise<RoslynCompiler>;
export { compileAssembly, analyzeAssembly, generateModule } from './il/index.js';
export default createRoslyn;
