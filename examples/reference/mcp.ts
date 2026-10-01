// MCP server exposing one tool, wait_for_human, to Claude Code, Codex or any MCP client.
// Usage: bun examples/reference/mcp.ts [--browser chrome]

import { parseArgs } from 'node:util';

import { type Cue, createCue, TabNotFoundError } from '../../src/index.ts';
import { type RemoteSource, remoteSource } from './remote.ts';
import { lines } from './wire.ts';

const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chrome' } } });

const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 1_800;

const TOOL = {
  name: 'wait_for_human',
  description: [
    'Wait for the user to finish something only they can do in a browser tab:',
    'sign in, pass 2FA or a CAPTCHA, approve a payment.',
    'First tell the user what to do. Then call this with the tab id from your browser tools.',
    'It returns when the tab navigates and settles, when the user leaves the tab,',
    'when the tab closes, or on timeout. It does not judge success:',
    'look at the tab again, and call this again if it is still blocked.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'integer', description: 'Chrome tab id, as used by your browser tools.' },
      timeoutSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TIMEOUT_S,
        description: `Longest wait. Default ${DEFAULT_TIMEOUT_S}.`,
      },
    },
    required: ['tabId'],
  },
};

const NEXT: Record<Cue['wake'], string> = {
  settled: 'The tab changed. Look at it again before continuing.',
  left: 'The user left the tab. Look at it again before continuing.',
  closed: 'The tab was closed. Ask the user how to continue.',
  timeout: 'Nothing happened. Call wait_for_human again to keep waiting, or ask the user.',
};

let source: Promise<RemoteSource> | undefined;
const getSource = () => {
  source ??= remoteSource(values.browser).catch((error) => {
    source = undefined;
    throw error;
  });
  return source;
};

async function callTool(args: { tabId?: number; timeoutSeconds?: number }) {
  if (!Number.isInteger(args.tabId)) return toolError('tabId must be an integer.');
  const timeoutS = Math.min(args.timeoutSeconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
  try {
    const cue = createCue(await getSource());
    const result = await cue(args.tabId as number, { timeoutMs: timeoutS * 1_000 });
    return { content: [{ type: 'text', text: `${JSON.stringify(result)}\n${NEXT[result.wake]}` }] };
  } catch (error) {
    if (error instanceof TabNotFoundError) return toolError(`No tab with id ${args.tabId}.`);
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

async function handle(method: string, params: any): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cue', version: '0.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call':
      if (params?.name !== TOOL.name) throw rpcError(-32602, `Unknown tool: ${params?.name}`);
      return callTool(params.arguments ?? {});
    default:
      throw rpcError(-32601, `Method not found: ${method}`);
  }
}

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const reply = (message: object) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

process.stdin.on(
  'data',
  lines(async (message: { id?: number | string; method: string; params?: unknown }) => {
    // Notifications (no id) need no reply.
    if (message.id === undefined) return;
    try {
      reply({ id: message.id, result: await handle(message.method, message.params) });
    } catch (error: any) {
      reply({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  }),
);
process.stdin.on('end', () => process.exit(0));
