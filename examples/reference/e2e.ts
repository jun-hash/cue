// End-to-end test: a throwaway Chrome profile with the reference extension loaded.
// CDP plays the human (navigates, switches tabs, closes them); cue must wake correctly.
// Never touches your own browser. Usage: bun examples/reference/e2e.ts [--headful]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import { createCue } from '../../src/index.ts';
import { EXTENSION_DIR } from './build.ts';
import { remoteSource } from './remote.ts';
import { CUE_DIR, lines, socketPath } from './wire.ts';

const HERE = resolve(import.meta.dirname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NAME = 'e2e';
const { values } = parseArgs({ options: { headful: { type: 'boolean' } } });

const profile = await mkdtemp(join(tmpdir(), 'cue-e2e-'));
await run(process.execPath, [join(HERE, 'install.ts'), '--user-data-dir', profile, '--name', NAME]);

// Chrome no longer honors --load-extension. CDP's Extensions.loadUnpacked over a debugging
// pipe is the supported way to load an unpacked extension into a scripted browser.
const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    ...(values.headful ? [] : ['--headless=new']),
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);
const cdp = pipeCdp(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: unknown) =>
  results.push([name, ok, JSON.stringify(detail)]);

try {
  await cdp('Extensions.loadUnpacked', { path: EXTENSION_DIR });
  await waitFor(() => existsSync(socketPath(NAME)), 20_000, 'extension never started the host');
  const source = await remoteSource(NAME);
  const cue = createCue(source);
  const fast = { settleMs: 500, timeoutMs: 15_000 };

  const open = async (title: string) => {
    const url = `data:text/html,<title>${title}</title>${title}`;
    const { targetId } = await cdp('Target.createTarget', { url });
    await waitFor(async () => (await source.tabs()).some((t) => t.url === url), 5_000, 'no tab');
    const tab = (await source.tabs()).find((t) => t.url === url);
    return { targetId, tabId: tab?.id as number };
  };
  const navigate = async (targetId: string, title: string) => {
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Page.navigate', { url: `data:text/html,<title>${title}</title>` }, sessionId);
  };

  // The human finishes in the tab and the page settles.
  const a = await open('signin');
  const settled = cue(a.tabId, fast);
  await sleep(300);
  await navigate(a.targetId, 'dashboard');
  const s = await settled;
  check('settled after navigation', s.wake === 'settled' && s.title === 'dashboard', s);

  // The human closes the tab.
  const closed = cue(a.tabId, fast);
  await sleep(300);
  await cdp('Target.closeTarget', { targetId: a.targetId });
  check('closed when the tab closes', (await closed).wake === 'closed', 'closed');

  // The human visits the tab, then switches to another one.
  const b = await open('two-factor');
  const other = await open('elsewhere');
  await cdp('Target.activateTarget', { targetId: b.targetId });
  await sleep(300);
  const left = cue(b.tabId, { ...fast, timeoutMs: 3_000 });
  await sleep(300);
  await cdp('Target.activateTarget', { targetId: other.targetId });
  const l = await left;
  check('left when the human switches tabs', l.wake === 'left', l);

  // The same flow through the MCP server, as Claude Code or Codex would call it.
  const c = await open('mcp');
  const mcp = spawn(process.execPath, [join(HERE, 'mcp.ts'), '--browser', NAME]);
  const replies = new Map<number, (value: any) => void>();
  mcp.stdout.on(
    'data',
    lines((m: any) => replies.get(m.id)?.(m)),
  );
  const rpc = (id: number, method: string, params: object) =>
    new Promise<any>((done) => {
      replies.set(id, done);
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const listed = await rpc(2, 'tools/list', {});
  check('mcp lists wait_for_human', listed.result?.tools?.[0]?.name === 'wait_for_human', listed);
  const call = rpc(3, 'tools/call', { name: 'wait_for_human', arguments: { tabId: c.tabId } });
  await sleep(500);
  await cdp('Target.closeTarget', { targetId: c.targetId });
  const text: string = (await call).result?.content?.[0]?.text ?? '';
  check('mcp tool returns the wake', text.includes('"wake":"closed"'), text.split('\n')[0]);
  mcp.kill();

  source.close();
} catch (error) {
  check('run', false, String(error));
} finally {
  chrome.kill();
  await new Promise((done) => chrome.once('exit', done));
  await rm(profile, { recursive: true, force: true });
  await rm(join(CUE_DIR, `host-${NAME}.sh`), { force: true });
}

for (const [name, ok, detail] of results) console.log(`${ok ? '✓' : '✗'} ${name}  ${detail}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) =>
    spawn(command, args, { stdio: 'ignore' }).once('exit', (code) =>
      code === 0 ? done() : fail(new Error(`${args[0]} exited ${code}`)),
    ),
  );
}

/** CDP over --remote-debugging-pipe: null-terminated JSON on fds 3 (in) and 4 (out). */
function pipeCdp(input: Writable, output: Readable) {
  let nextId = 0;
  let buffer = '';
  const pending = new Map<number, (m: any) => void>();
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
    }
  });
  return (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((done, fail) => {
      const id = ++nextId;
      pending.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : done(m.result)));
      input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
}

async function waitFor(test: () => unknown, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await Promise.resolve(test()).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}
