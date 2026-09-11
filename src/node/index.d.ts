import type { RoslynCompiler, RoslynOptions } from '../index.js';
export { RoslynError } from '../index.js';
export type * from '../index.js';

export interface NodeRoslynOptions extends Omit<RoslynOptions, 'Worker'|'worker'> {
  /** Filesystem directory or file: URL containing the prebuilt runtime. Defaults to this package's dist/. */
  baseUrl?: string|URL;
  /** The Node host always uses a worker so timeout/abort can terminate managed code. */
  worker?: true;
  /** Raw worker console output defaults to process.stderr. Managed stdout/stderr remain onEvent events and execution results. */
  onWorkerOutput?: (text: string, stream: 'stdout'|'stderr') => void;
}
export interface NodeRoslynCompiler extends RoslynCompiler {
  /** Dispose the compiler and await worker termination. Safe to call repeatedly. */
  close(): Promise<void>;
}
export function createRoslyn(options?: NodeRoslynOptions): Promise<NodeRoslynCompiler>;
export default createRoslyn;
