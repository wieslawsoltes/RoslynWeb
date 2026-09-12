import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createNetDxf } from '../../src/dxf/index.js';

// roslynweb script examples/cli/netdxf.mjs -- [input.dxf|-] [output.dxf] [text|binary]
// '-' creates the same drawing as the browser sample.
export default async function ({ compiler, args }) {
  const [input = '-', output = 'out/netdxf-sample.dxf', format = 'text'] = args;
  if (!['text', 'binary'].includes(format) || args.length > 3) {
    throw new Error('Usage: netdxf.mjs [input.dxf|-] [output.dxf] [text|binary]');
  }
  const session = await createNetDxf({ compiler });
  try {
    const document = input === '-' ? await session.createSample() : await session.load(await readFile(input));
    const bytes = await document.export({ binary: format === 'binary' });
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    // Parse the written bytes through the full library again before reporting success.
    const reopened = await session.load(bytes);
    return {
      backend: session.info.backend,
      upstream: session.info.upstream,
      output: target,
      format,
      bytes: bytes.length,
      original: document.stats,
      reopened: reopened.stats,
      viewerIssues: document.issues,
    };
  } finally {
    await session.dispose();
  }
}
