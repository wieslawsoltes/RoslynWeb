export { NuGetResolver, importNupkg } from './packages/index.js';
import type { PackageResolution, ImportedPackage, NuGetResolverOptions, PackageRequest, PackageImportOptions } from './packages/index.js';
import type { ProjectOptions, ProjectBuildResult, ProjectEvaluation } from './projects/index.js';
export type Bytes = Uint8Array | ArrayBuffer | ArrayBufferView;
export interface SourceFile { path: string; text: string }
export interface Diagnostic { id: string; severity: 'error'|'warning'|'info'|'hidden'; message: string; path: string; startLine: number; startColumn: number; endLine: number; endColumn: number; warningLevel?: number }
export interface CompileOptions {
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
  elapsedMs: number;
  generatedSources?: Array<{ hintName: string; path?: string; text: string; generator?: string }>;
  generatorDiagnostics?: Diagnostic[];
  analyzerDiagnostics?: Diagnostic[];
  compilerExtensionsReport?: Record<string,unknown>;
}
export type AssemblyInput = CompilationResult | Bytes | string;
export type JavaScriptExternal = ((...args:any[])=>any) | {raw:true;invoke(context:any):any};
export interface ExecutionOptions {
  backend?: 'wasm'|'javascript'|'auto';
  args?: string[];
  timeoutMs?: number;
  maxInstructions?: number;
  maxSteps?: number;
  externals?: Record<string, JavaScriptExternal> | Map<string, JavaScriptExternal>;
  assemblies?: AssemblyModel[];
  /** JavaScript backend only. Supplying virtual-file options rejects WebAssembly execution, including an auto-mode fallback. Each run starts with a fresh filesystem. */
  virtualFiles?: Record<string,string|Uint8Array|number[]>;
  /** Return a copied filesystem snapshot, including untouched input files; JavaScript backend only. */
  captureVirtualFiles?: boolean;
  /** Total bytes permitted in the JavaScript virtual filesystem. */
  maxVirtualFileBytes?: number;
}
export interface ExecutionResult {
  success: boolean; backend?: 'wasm'|'javascript'; result?: unknown; exitCode: number;
  stdout: string; stderr: string; error?: ManagedError; elapsedMs?: number;
  analysis?: unknown; fallback?: unknown; virtualFiles?: Record<string,Uint8Array>;
}
export interface CompilerInfo { bridgeVersion: string; roslynVersion: string; runtimeVersion: string; referenceCount: number; execution: string }
export interface CompilerEvent { type: string; stage?: string; message?: string; text?: string; [key: string]: unknown }
export interface RoslynOptions {
  /** Abort startup and compiler lifetime. Workers are terminated; worker:false rejects pending calls and disables later calls but cannot interrupt managed code already executing in the caller's realm. */
  signal?: AbortSignal;
  baseUrl?: string|URL; worker?: boolean; workerUrl?: string|URL;
  timeoutMs?: number; startupTimeoutMs?: number; config?: Record<string,unknown>;
  onEvent?: (event: CompilerEvent) => void;
}
export interface ReferenceInfo { name: string; fileName: string; userSupplied: boolean }
export interface Registration { success: boolean; name: string; assemblyName: string; bytes: number }
export interface ObjectHandle { $handle: string; typeName: string }
export interface InvocationOptions { parameterTypes?: string[]; genericArguments?: string[]; returnHandle?: boolean; includeArguments?: boolean }
export interface FunctionSpec { name?: string; typeName?: string; assemblyName?: string; returnType?: string; parameters?: Array<{name:string;type:string}>; usings?: string[]; body?: string; compileOptions?: CompileOptions }
export interface CompiledFunction { success:true; assembly:CompilationResult; source:string; typeName:string; methodName:string; invoke(...args:unknown[]):Promise<ExecutionResult> }
export interface ResourceEntry { name:string; type?:string; value:unknown }
export interface EmbeddedResource { name:string; isPublic?:boolean; base64?:string; resx?:string; entries?:ResourceEntry[] }
export interface ResourceResult { success:boolean; base64?:string; bytes?:Uint8Array; diagnostics?:Diagnostic[]; error?:ManagedError }
export interface BuildTaskRequest { parameters?:Record<string,unknown>; files?:Array<{path:string;base64:string}>; workingDirectory?:string; virtualPaths?:boolean; outputProperties?:string[]; maxFileBytes?:number }
export interface BuildTaskResult { success:boolean; outputs?:Record<string,unknown>; diagnostics?:Array<Record<string,unknown>>; files?:Array<{path:string;base64:string}>; removedFiles?:string[]; stdout?:string; stderr?:string; error?:ManagedError }
export interface RoslynCompiler {
  readonly info: CompilerInfo;
  readonly disposed: boolean;
  onEvent(listener: (event: CompilerEvent) => void): () => void;
  compile(source: string|SourceFile[]|CompileRequest, options?: CompileOptions): Promise<CompilationResult>;
  addReference(name: string, bytes: Bytes): Promise<Registration>;
  addAssembly(name: string, bytes: Bytes): Promise<Registration>;
  addDll(name: string, bytes: Bytes): Promise<{reference: Registration; assembly: Registration}>;
  addCompilerExtension(name: string, bytes: Bytes): Promise<Record<string,unknown>>;
  compilerExtensions(): Promise<Array<Record<string,unknown>>>;
  loadCompilerReferences(): Promise<string[]>;
  loadTaskReferences(): Promise<string[]>;
  executeBuildTask(assembly:AssemblyInput,typeName:string,request?:BuildTaskRequest):Promise<BuildTaskResult>;
  createResources(entries:ResourceEntry[]):Promise<ResourceResult>;
  convertResx(xml:string):Promise<ResourceResult>;
  buildProject(options: ProjectOptions): Promise<ProjectBuildResult>;
  evaluateProject(options: ProjectOptions): Promise<ProjectEvaluation>;
  references(): Promise<ReferenceInfo[]>;
  inspect(assembly: AssemblyInput): Promise<AssemblyModel>;
  restore(packages: PackageRequest[], options?: NuGetResolverOptions & {resolver?: unknown}): Promise<PackageResolution>;
  importPackage(bytes: Bytes, options?: PackageImportOptions): Promise<ImportedPackage>;
  loadPackages(packages: PackageResolution|ImportedPackage): Promise<PackageResolution|ImportedPackage>;
  run(assembly: AssemblyInput, options?: ExecutionOptions): Promise<ExecutionResult>;
  invoke(assemblyIdOrBase64: string, typeName: string, methodName: string, args?: unknown[], options?: InvocationOptions): Promise<ExecutionResult>;
  createObject(assemblyIdOrBase64:string,typeName:string,args?:unknown[],options?:InvocationOptions):Promise<ObjectHandle>;
  invokeObject(handle:ObjectHandle|string,methodName:string,args?:unknown[],options?:InvocationOptions):Promise<ExecutionResult>;
  getProperty(handle:ObjectHandle|string,name:string):Promise<unknown>;
  setProperty(handle:ObjectHandle|string,name:string,value:unknown):Promise<ExecutionResult>;
  releaseObject(handle:ObjectHandle|string):Promise<{success:boolean}>;
  compileFunction(spec:FunctionSpec):Promise<CompiledFunction|CompilationResult>;
  evaluate(expression:string,options?:FunctionSpec & {arguments?:unknown[]}):Promise<ExecutionResult|CompilationResult>;
  emitJavaScript(assembly: AssemblyInput, options?: Record<string,unknown>): Promise<{model:AssemblyModel;analysis:unknown;source:string}>;
  dispose(): void;
}
export class RoslynError extends Error { code: string; details?: unknown }
export function createRoslyn(options?: RoslynOptions): Promise<RoslynCompiler>;
export function compileAssembly(model: AssemblyModel, options?: Record<string,unknown>): any;
export function analyzeAssembly(model: AssemblyModel, options?: Record<string,unknown>): any;
export function generateModule(model: AssemblyModel, options?: Record<string,unknown>): string;
export default createRoslyn;
