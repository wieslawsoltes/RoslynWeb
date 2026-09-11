import type { Bytes, CompilationResult, CompilerInfo, RoslynCompiler } from '../index.js';
import type { DxfIssue, DxfLayer, DxfScene } from './geometry.js';
export * from './geometry.js';
export * from './renderer.js';
export * from './kernel.js';

export class NetDxfError extends Error {
  constructor(message: string, code?: string, details?: unknown);
  code: string;
  details?: unknown;
}
export interface NetDxfAsset { file: string; bytes: number; sha256: string }
export interface NetDxfInfo {
  version: 1;
  upstream: { repository: string; branch: string; commit: string };
  sourceCount: number;
  sourceBytes: number;
  compilation: { assemblyName: string; defines: string[]; sourceChanges: boolean; target: string; signed: boolean; notes: string };
  compiler: CompilerInfo;
  library: NetDxfAsset;
  bridge: NetDxfAsset;
  sourceBundle: NetDxfAsset;
  mode: 'prebuilt' | 'source';
  /** Full managed .NET WebAssembly execution, not native IL-to-Wasm compilation. */
  backend: 'wasm';
}
export interface NetDxfStats {
  entityCount: number;
  layerCount: number;
  sourceEntities: number;
  renderedEntities: number;
  hiddenEntities: number;
  unsupportedEntities: number;
  layers: number;
  blocks: number;
  curvePrecision: number;
  layout: string;
}
export interface NetDxfScene extends DxfScene { layers: DxfLayer[]; issues: DxfIssue[]; stats: NetDxfStats }
export interface NetDxfSnapshot { handle: string; scene: NetDxfScene; stats: NetDxfStats; issues: DxfIssue[] }
export interface NetDxfDocument {
  readonly handle: string;
  readonly scene: NetDxfScene;
  readonly stats: NetDxfStats;
  readonly issues: DxfIssue[];
  readonly disposed: boolean;
  inspect(): NetDxfSnapshot;
  refresh(): Promise<NetDxfScene>;
  export(options?: { binary?: boolean }): Promise<Uint8Array>;
  /** Release the managed document. Safe to call repeatedly. */
  dispose(): Promise<void>;
}
export interface NetDxfSession {
  readonly compiler: RoslynCompiler;
  readonly info: NetDxfInfo;
  readonly compilation?: { library: CompilationResult; bridge: CompilationResult };
  readonly disposed: boolean;
  createSample(): Promise<NetDxfDocument>;
  load(input: Bytes | string): Promise<NetDxfDocument>;
  /** Release all owned document handles; the caller still owns the compiler. */
  dispose(): Promise<void>;
}
export interface NetDxfOptions {
  compiler: RoslynCompiler;
  /** Directory containing the generated netDxf manifest and assemblies. */
  baseUrl?: URL | string;
  /** Compile every unchanged upstream source file with Roslyn WASM. Default false. */
  compile?: boolean;
  onProgress?: (event: { stage: string; message: string; sourceCount?: number }) => void;
  /** Validate downloaded byte counts and SHA-256 hashes. Default true. */
  verify?: boolean;
  /** Browser fetch and local Node file: URLs are supported by default. */
  loadAsset?: (url: URL) => Promise<Bytes>;
  /** Maximum individual DXF input size. Default 32 MiB. */
  maxInputBytes?: number;
}
export function createNetDxf(options: NetDxfOptions): Promise<NetDxfSession>;
export default createNetDxf;
