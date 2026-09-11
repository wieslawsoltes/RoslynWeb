import type { PackageResolution, PackageRequest, NuGetResolverOptions } from '../packages/index.js';
export type VirtualFile = string | Uint8Array | ArrayBuffer;
export interface ProjectDiagnostic { id?: string; severity?: string; message: string; path?: string; [key: string]: unknown; }
export interface ProjectItem { include: string; path?: string; recursiveDir?: string; metadata: Record<string,string>; }
export interface ManagedTaskItem { itemSpec:string; metadata?:Record<string,string>; }
export interface ManagedBuildTaskRequest {
 parameters?:Record<string,unknown>;
 files?:Array<{path:string;base64:string}>;
 workingDirectory?:string;
 virtualPaths?:boolean;
 outputProperties?:string[];
 continueOnError?:boolean;
}
export interface ManagedBuildTaskResult {
 success:boolean;
 outputs?:Record<string,unknown>;
 diagnostics?:ProjectDiagnostic[];
 files?:Array<{path:string;base64:string}>;
 removedFiles?:string[];
 error?:unknown;
}
export interface ProjectUsingTask { name:string; file:string; override:boolean; assemblyName?:string; assemblyFile?:string; }
export interface ProjectCompiler {
 compile(sources: Array<{path:string;text:string}>, options: Record<string,unknown>): Promise<{success:boolean;pe?:Uint8Array;pdb?:Uint8Array;diagnostics?:ProjectDiagnostic[];[key:string]:unknown}>;
 addReference(name:string,bytes:Uint8Array): Promise<unknown>;
 addAssembly?(name:string,bytes:Uint8Array): Promise<unknown>;
 addCompilerExtension?(name:string,bytes:Uint8Array): Promise<unknown>;
 loadPackages?(resolution:PackageResolution):Promise<unknown>;
 restore?(requests:PackageRequest[], options?:NuGetResolverOptions):Promise<PackageResolution>;
 executeBuildTask?(assemblyIdOrBase64:string,taskName:string,request:ManagedBuildTaskRequest):Promise<ManagedBuildTaskResult>;
 convertResx?(xml:string):Promise<{success:boolean;base64?:string;bytes?:Uint8Array;diagnostics?:ProjectDiagnostic[]}>;
}
export interface ProjectCommandRequest {
 command:string;
 args:string[];
 env:Record<string,string>;
 workingDirectory:string;
 files:Record<string,Uint8Array>;
 directories:string[];
 signal?:AbortSignal;
}
export interface ProjectCommandResult {
 exitCode:number;
 stdout?:string;
 stderr?:string;
 files?:Record<string,VirtualFile>|Map<string,VirtualFile>;
 removedFiles?:string[];
 directories?:string[];
 success?:boolean;
}
export interface ProjectSatelliteAssembly { culture:string; name:string; path:string; pe:Uint8Array; }
export interface ProjectOptions {
 projectPath?: string;
 files: Map<string,VirtualFile> | Record<string,VirtualFile>;
 properties?: Record<string,string>;
 targets?: string[];
 restore?: boolean | ((requests:PackageRequest[], options:NuGetResolverOptions)=>Promise<PackageResolution>);
 restoreOptions?: NuGetResolverOptions;
 packageResolution?: PackageResolution;
 propsImports?: string[];
 targetsImports?: string[];
 signal?: AbortSignal;
 onMessage?: (diagnostic:ProjectDiagnostic)=>void;
 /** Explicit registered browser/WASI command adapter. Exec never starts an OS shell. */
 commandRunner?:(request:ProjectCommandRequest)=>Promise<ProjectCommandResult>;
 /** Retain between builds and pass the previous result.files to reuse unchanged generation targets. */
 incrementalCache?: Map<string,unknown>;
}
export interface ProjectEvaluation {
 projectPath: string;
 properties: Record<string,string>;
 items: Record<string,ProjectItem[]>;
 imports: string[];
 targets: string[];
 usingTasks: ProjectUsingTask[];
 files: Map<string,VirtualFile>;
 diagnostics: ProjectDiagnostic[];
}
export interface ProjectBuildResult extends ProjectEvaluation {
 success: boolean;
 compileResult: Awaited<ReturnType<ProjectCompiler['compile']>> | null;
 pe?: Uint8Array;
 pdb?: Uint8Array;
 generatedFiles: Map<string,VirtualFile>;
 skippedTargets: string[];
 targetOutputs: Record<string,string[]>;
 projectReferences: ProjectBuildResult[];
 satelliteAssemblies: ProjectSatelliteAssembly[];
 packages: PackageResolution | null;
 error?: {code:string;message:string;details?:Record<string,unknown>};
}
export class ProjectError extends Error { code:string; details:Record<string,unknown>; constructor(code:string,message:string,details?:Record<string,unknown>); }
export function normalizePath(value:string,base?:string):string;
export function evaluateProject(options:ProjectOptions):ProjectEvaluation;
export function buildProject(compiler:ProjectCompiler,options:ProjectOptions):Promise<ProjectBuildResult>;
