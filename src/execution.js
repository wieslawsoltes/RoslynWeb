import { compileAssembly } from './il/index.js';
export async function executeJavaScript(model, options = {}) {
  let stdout = '';
  const executable = compileAssembly(model, {
    externals: options.externals,
    assemblies: options.assemblies,
    output: (text, meta) => { stdout += String(text) + (meta?.newline ? '\n' : ''); },
    maxInstructions: options.maxInstructions ?? options.maxSteps ?? 10000000
  });
  try {
    const result = await executable.run(options.args || []);
    return { success: true, backend: 'javascript', result, exitCode: typeof result === 'number' ? result : 0, stdout, stderr: '', analysis: executable.analysis };
  } catch (error) {
    return { success: false, backend: 'javascript', exitCode: 1, stdout, stderr: '', error: { type: error.name, message: error.message, stack: error.stack, details: error.details }, analysis: executable.analysis };
  }
}
