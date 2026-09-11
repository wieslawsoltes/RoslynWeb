import { createRoslyn } from '@roslynweb/core/node';

const compiler = await createRoslyn();
try {
  const source = 'System.Console.WriteLine("Node API running Roslyn in WebAssembly");';
  const assembly = await compiler.compile(source, { assemblyName: 'NodeExample' });
  if (!assembly.success) throw new Error(JSON.stringify(assembly.diagnostics));
  const result = await compiler.run(assembly, { backend: 'wasm' });
  if (!result.success) throw new Error(result.error?.message || 'Execution failed');
  process.stdout.write(result.stdout);
} finally {
  await compiler.close();
}
