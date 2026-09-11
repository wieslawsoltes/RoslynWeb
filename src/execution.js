import { compileAssembly } from './il/index.js';
import { VirtualFileSystem } from './il/io.mjs';
export async function executeJavaScript(model, options = {}) {
  let stdout = '';
  const virtualFileSystem = options.virtualFiles !== undefined || options.captureVirtualFiles !== undefined || options.maxVirtualFileBytes !== undefined
    ? new VirtualFileSystem({files: options.virtualFiles, maxBytes: options.maxVirtualFileBytes}) : undefined;
  const executable = compileAssembly(model, {
    externals: options.externals,
    assemblies: options.assemblies,
    virtualFiles: options.virtualFiles,
    virtualFileSystem,
    maxVirtualFileBytes: options.maxVirtualFileBytes,
    output: (text, meta) => { stdout += String(text) + (meta?.newline ? '\n' : ''); },
    maxInstructions: options.maxInstructions ?? options.maxSteps ?? 10000000
  });
  const fileResult = () => options.captureVirtualFiles ? {virtualFiles: (executable.$virtualFileSystem || virtualFileSystem)?.snapshot() || {}} : {};
  try {
    const result = await executable.run(options.args || []);
    return { success: true, backend: 'javascript', ...fileResult(), result, exitCode: typeof result === 'number' ? result : 0, stdout, stderr: '', analysis: executable.analysis };
  } catch (error) {
    return { success: false, backend: 'javascript', ...fileResult(), exitCode: 1, stdout, stderr: '', error: { type: error.name, message: error.message, stack: error.stack, details: error.details }, analysis: executable.analysis };
  }
}
