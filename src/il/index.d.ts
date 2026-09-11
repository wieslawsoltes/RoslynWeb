/** Normalized ECMA-335 assembly metadata returned by Roslyn's inspector. */
export interface ILAssemblyModel { name: string; types: Array<Record<string, unknown>>; [key: string]: unknown; }
export interface ILDiagnostic { severity: 'error'|'warning'|'info'; code: string; message: string; method?: string; token?: number; offset?: number; opcode?: string; }
export interface ILMethodReference { name: string; declaringType: string; token?: number; assemblyName?: string; isStatic?: boolean; returnType?: string; parameters?: Array<string|{type:string;name?:string}>; genericArguments?: string[]; [key:string]: unknown; }
export interface ILAnalysis {
  assembly: string; supported: boolean; executable: boolean; methods: number;
  totalInstructions: number; supportedInstructions: number; opcodes: Record<string,number>;
  dependencies: Array<{method:ILMethodReference;kind:'builtin'|'unresolved';overloadValidatedAtRuntime?:boolean}>;
  diagnostics: ILDiagnostic[]; capabilities: typeof capabilities;
}
export type JavaScriptOptimization = boolean | 'blocks';
export interface JavaScriptOptimizationStats {
  enabled: boolean; mode: 'reference'|'blocks'|'numeric'; methods: number; numericMethods: number;
  basicBlocks: number; instructions: number; generatedSourceBytes: number;
}
export type ILExternal = ((...args: any[])=>unknown) | {invoke?: (...args:any[])=>unknown;raw?:boolean;get?:()=>unknown;set?:(value:unknown)=>void};
export interface JavaScriptRuntimeOptions {
  maxInstructions?: number; maxCallDepth?: number; maxArrayLength?: number;
  maxVirtualFileBytes?: number; virtualFiles?: Record<string,string|Uint8Array|number[]>;
  virtualFileSystem?: VirtualFileSystem;
  externals?: Record<string,ILExternal>|Map<string,ILExternal>;
  output?: (text:string,metadata?:{newline?:boolean})=>void;
  [key:string]: unknown;
}
export interface JavaScriptCompileOptions extends JavaScriptRuntimeOptions {
  /** true (default) specializes eligible Int32 methods; 'blocks' groups IL blocks; false retains reference instruction dispatch. */
  optimize?: JavaScriptOptimization;
  /** Reject unresolved or unsupported IL before generating methods. */
  strict?: boolean;
  /** URL imported by standalone generated ES modules. */
  runtimeImport?: string;
  assemblies?: ILAssemblyModel[];
}
export interface JavaScriptCompiledModule {
  readonly model: ILAssemblyModel;
  readonly source: string;
  readonly analysis: ILAnalysis;
  readonly optimization: JavaScriptOptimizationStats;
  readonly generatedSourceBytes: number;
  readonly compiledMethods: Record<string, Function>;
  readonly linked: Array<{model:ILAssemblyModel;compiledMethods:Record<string,Function>}>;
  /** Creates isolated managed state while reusing the compiled JavaScript functions. */
  createRuntime(options?:JavaScriptRuntimeOptions): ILRuntime;
}
export class ILRuntime {
  constructor(model:ILAssemblyModel,options?:JavaScriptRuntimeOptions);
  readonly model: ILAssemblyModel;
  analysis?: ILAnalysis; diagnostics?: ILDiagnostic[]; optimization?: JavaScriptOptimizationStats; readonly source?: string;
  instructionCount: number; maxInstructions: number;
  invoke(method:string|number|ILMethodReference,args?:unknown[],options?:{self?:unknown;assembly?:string;raw?:boolean}):unknown;
  run(args?:string[],options?:{assembly?:string;raw?:boolean}):unknown;
  addAssembly(model:ILAssemblyModel,compiledMethods?:Record<string,Function>): this;
  [key:string]: unknown;
}
export function compileJavaScriptModule(model:ILAssemblyModel,options?:JavaScriptCompileOptions):JavaScriptCompiledModule;
export function compileAssembly(model:ILAssemblyModel,options?:JavaScriptCompileOptions):ILRuntime;
export function createRuntime(model:ILAssemblyModel,options?:JavaScriptRuntimeOptions):ILRuntime;
export function analyzeAssembly(model:ILAssemblyModel,options?:JavaScriptCompileOptions):ILAnalysis;
export function generateModule(model:ILAssemblyModel,options?:JavaScriptCompileOptions):string;
export function generateMethod(method:Record<string,unknown>,options?:JavaScriptCompileOptions):string;
export function isOpcodeSupported(opcode:string):boolean;
export function isBuiltinCandidate(reference:ILMethodReference):boolean;
export const capabilities: Readonly<{format:string;execution:string;numericKinds:readonly string[];supported:readonly string[];unsupported:readonly string[];notes:readonly string[]}>;
export class ILCompilationError extends Error {constructor(message:string,diagnostics?:ILDiagnostic[]);diagnostics:ILDiagnostic[];}
export class ILExecutionError extends Error {constructor(message:string,details?:Record<string,unknown>);runtimeLimitation?:boolean;}
export class ManagedException extends Error {constructor(type:string,message?:string,inner?:unknown);$type:string;}
export class Numeric {constructor(kind:'i4'|'i8'|'r4'|'r8',value:number|bigint);kind:'i4'|'i8'|'r4'|'r8';value:number|bigint;}
export function i4(value:number|boolean):Numeric;
export function i8(value:number|bigint|string):Numeric;
export function r4(value:number):Numeric;
export function r8(value:number):Numeric;
export function binary(opcode:string,left:Numeric,right:Numeric):Numeric;
export function unary(opcode:string,value:Numeric):Numeric;
export function compare(opcode:string,left:unknown,right:unknown):boolean;
export function convert(opcode:string,value:Numeric):Numeric;
export function fromJS(value:unknown,type?:string):unknown;
export function toJS(value:unknown):unknown;
export function methodKey(method:ILMethodReference):string;
export function splitTypeArguments(type:string):string[];
export function substituteType(type:string,typeArguments?:string[],methodArguments?:string[]):string;
export const BindingFlags: Readonly<Record<string,number>>;
export function reflectionType(runtime:ILRuntime,type:string):unknown;
export class VirtualFileSystem {
  constructor(options?:{files?:Record<string,string|Uint8Array|number[]>;maxBytes?:number});
  cwd:string;maxBytes:number;
  snapshot():Record<string,Uint8Array>;normalize(path:string):string;mkdir(path:string):string;
  readFile(path:string):Uint8Array;writeFile(path:string,value:string|Uint8Array|number[]):unknown;
  list(path:string,pattern?:string,recursive?:boolean,kind?:'all'|'dirs'|'files'):string[];
}
export interface ILMethodOptions {isStatic?:boolean;returnType?:string;parameters?:Array<string|{name?:string;type:string}>;[key:string]:unknown;}
export interface ILLabel {readonly $label:true;readonly name:string;readonly owner:ILMethodBuilder;}
export class ILAssemblyBuilder {
  constructor(name?:string);name:string;types:ILTypeBuilder[];entryPoint:number|null;
  defineType(name:string,options?:Record<string,unknown>):ILTypeBuilder;setEntryPoint(method:ILMethodBuilder):this;
  toModel():ILAssemblyModel;analyze(options?:JavaScriptCompileOptions):ILAnalysis;
  compile(options?:JavaScriptCompileOptions):ILRuntime;generateModule(options?:JavaScriptCompileOptions):string;
}
export class ILTypeBuilder {
  constructor(assembly:ILAssemblyBuilder,name:string,options?:Record<string,unknown>);assembly:ILAssemblyBuilder;name:string;token:number;
  defineField(name:string,type?:string,options?:Record<string,unknown>):Record<string,unknown>;
  defineMethod(name:string,options?:ILMethodOptions):ILMethodBuilder;
  defineConstructor(parameters?:Array<string|{name?:string;type:string}>,options?:ILMethodOptions):ILMethodBuilder;
  toModel():Record<string,unknown>;
}
export class ILMethodBuilder {
  constructor(type:ILTypeBuilder,name:string,options?:ILMethodOptions);type:ILTypeBuilder;name:string;token:number;isStatic:boolean;returnType:string;
  asReference():ILMethodReference;declareLocal(type:string,options?:{pinned?:boolean}):number;
  defineLabel(name?:string):ILLabel;markLabel(label:ILLabel):this;emit(opcode:string,operand?:unknown):this;
  addExceptionHandler(region:{kind?:'catch'|'finally'|'fault'|'filter';tryStart:ILLabel;tryEnd:ILLabel;handlerStart:ILLabel;handlerEnd:ILLabel;catchType?:string|null;filterStart?:ILLabel|null}):this;
  toModel():Record<string,unknown>;
}
export class DynamicMethodBuilder extends ILMethodBuilder {
  constructor(name:string,returnType?:string,parameters?:Array<string|{name?:string;type:string}>,options?:ILMethodOptions);
  assembly:ILAssemblyBuilder;compile(options?:JavaScriptCompileOptions):ILRuntime;
  createDelegate(options?:JavaScriptCompileOptions):((...args:unknown[])=>unknown)&{readonly runtime:ILRuntime};
  generateModule(options?:JavaScriptCompileOptions):string;
}
