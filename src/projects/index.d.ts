import type { PackageResolution, PackageRequest, NuGetResolverOptions } from '../packages/index.js';
export type VirtualFile = string | Uint8Array | ArrayBuffer;
export interface ProjectDiagnostic { id?: string; severity?: string; message: string; path?: string; [key: string]: unknown; }
export interface ProjectItem { include: string; path?: string; recursiveDir?: string; metadata: Record<string,string>; }
export interface ProjectCompiler {
 compile(sources: Array<{path:string;text:string}>, options: Record<string,unknown>): Promise<{success:boolean;pe?:Uint8Array;pdb?:Uint8Array;diagnostics?:ProjectDiagnostic[];[key:string]:unknown}>;
 addReference(name:string,bytes:Uint8Array): Promise<unknown>;
 addAssembly?(name:string,bytes:Uint8Array): Promise<unknown>;
 addCompilerExtension?(name:string,bytes:Uint8Array): Promise<unknown>;
 loadPackages?(resolution:PackageResolution):Promise<unknown>;
 restore?(requests:PackageRequest[], options?:NuGetResolverOptions):Promise<PackageResolution>;
}
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
}
export interface ProjectEvaluation {
 projectPath: string;
 properties: Record<string,string>;
 items: Record<string,ProjectItem[]>;
 imports: string[];
 targets: string[];
 files: Map<string,VirtualFile>;
 diagnostics: ProjectDiagnostic[];
}
export interface ProjectBuildResult extends ProjectEvaluation {
 success: boolean;
 compileResult: Awaited<ReturnType<ProjectCompiler['compile']>> | null;
 pe?: Uint8Array;
 pdb?: Uint8Array;
 generatedFiles: Map<string,VirtualFile>;
 projectReferences: ProjectBuildResult[];
 packages: PackageResolution | null;
 error?: {code:string;message:string;details?:Record<string,unknown>};
}
export class ProjectError extends Error { code:string; details:Record<string,unknown>; constructor(code:string,message:string,details?:Record<string,unknown>); }
export function normalizePath(value:string,base?:string):string;
export function evaluateProject(options:ProjectOptions):ProjectEvaluation;
export function buildProject(compiler:ProjectCompiler,options:ProjectOptions):Promise<ProjectBuildResult>;
