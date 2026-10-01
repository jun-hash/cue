// Bundles the reference extension's service worker into extension/background.js.

import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname);

export const EXTENSION_DIR = join(HERE, 'extension');

export async function buildExtension(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(EXTENSION_DIR, 'background.ts')],
    outdir: EXTENSION_DIR,
    target: 'browser',
    format: 'esm',
  });
  if (!result.success) throw new AggregateError(result.logs, 'Extension build failed');
}

if (import.meta.main) await buildExtension();
