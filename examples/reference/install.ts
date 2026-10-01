// Builds the reference extension and registers its native host with Chrome.
// Usage: bun examples/reference/install.ts [--user-data-dir <dir>] [--name chrome] [--uninstall]

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { buildExtension } from './build.ts';
import { EXTENSION_ID, HOST_NAME } from './protocol.ts';
import { CUE_DIR } from './wire.ts';

const HERE = resolve(import.meta.dirname);
const CHROME_DATA_DIR = join(homedir(), 'Library/Application Support/Google/Chrome');

const { values } = parseArgs({
  options: {
    'user-data-dir': { type: 'string', default: CHROME_DATA_DIR },
    name: { type: 'string', default: 'chrome' },
    uninstall: { type: 'boolean' },
  },
});

const manifestPath = join(values['user-data-dir'], 'NativeMessagingHosts', `${HOST_NAME}.json`);
const launcher = join(CUE_DIR, `host-${values.name}.sh`);

if (values.uninstall) {
  await rm(manifestPath, { force: true });
  await rm(launcher, { force: true });
  console.log(`Removed the cue host for ${values.name}.`);
  process.exit(0);
}

await buildExtension();

// Chrome starts native hosts with a minimal PATH, so pin the runtime binary.
await mkdir(CUE_DIR, { recursive: true, mode: 0o700 });
await writeFile(
  launcher,
  `#!/bin/sh\nCUE_BROWSER=${values.name} exec "${process.execPath}" "${join(HERE, 'host.ts')}"\n`,
);
await chmod(launcher, 0o755);

await mkdir(join(values['user-data-dir'], 'NativeMessagingHosts'), { recursive: true });
const manifest = {
  name: HOST_NAME,
  description: 'cue native host',
  path: launcher,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const mcp = `"${process.execPath}" "${join(HERE, 'mcp.ts')}"`;
console.log(`Registered the cue host: ${manifestPath}

Next:
  1. chrome://extensions → Developer mode → Load unpacked → ${join(HERE, 'extension')}
  2. Claude Code:  claude mcp add cue -- ${mcp}
     Codex:        add to ~/.codex/config.toml
                   [mcp_servers.cue]
                   command = "${process.execPath}"
                   args = ["${join(HERE, 'mcp.ts')}"]
                   tool_timeout_sec = 1800`);
