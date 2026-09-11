import type {RoslynCompiler} from '../index.js';
export const netDxfKernelMethods:readonly string[];
export interface NetDxfKernel {
  backend:'wasm'|'javascript'|'native-wasm';
  info:Readonly<{backend:string;methods:readonly string[];assemblyBytes:number;artifactBytes:number;compiledMethods:number;diagnostics:number;compileMs:number;scope:string}>;
  invoke(method:string,args?:number[]):number|Promise<number>;
  dispose():void;
}
export function createNetDxfKernel(options:{compiler:RoslynCompiler;backend?:'wasm'|'javascript'|'native-wasm';baseUrl?:string|URL;source?:string;optimize?:boolean}):Promise<NetDxfKernel>;
