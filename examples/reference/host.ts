// Native messaging host. Chrome starts it when the extension connects, and closes stdin when the
// extension goes away. It relays between the extension (stdio) and MCP servers (Unix socket).

import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';

import type { Message, Request } from './protocol.ts';
import { CUE_DIR, encodeFrame, frames, lines, socketPath } from './wire.ts';

interface Client {
  socket: Socket;
  watched: Set<number>;
}

const path = socketPath(process.env.CUE_BROWSER ?? 'chrome');
const clients = new Set<Client>();
/** Our request id → the client that asked and its own id. */
const pending = new Map<number, { client: Client; id: number }>();
let nextId = 0;

const toExtension = (request: Request) => process.stdout.write(encodeFrame(request));
const send = (client: Client, message: Message) =>
  client.socket.write(`${JSON.stringify(message)}\n`);
const watchers = (tabId: number) => [...clients].filter((c) => c.watched.has(tabId)).length;

function fromExtension(message: Message): void {
  if ('event' in message) {
    for (const client of clients) if (client.watched.has(message.tabId)) send(client, message);
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  send(request.client, { ...message, id: request.id });
}

function fromClient(client: Client, request: Request): void {
  const id = ++nextId;
  pending.set(id, { client, id: request.id });
  // The extension watches each tab once, however many clients wait on it.
  if (request.op === 'watch') {
    const first = watchers(request.tabId) === 0;
    client.watched.add(request.tabId);
    if (!first) {
      fromExtension({ id, result: null });
      return;
    }
  }
  if (request.op === 'unwatch') {
    client.watched.delete(request.tabId);
    if (watchers(request.tabId) > 0) {
      fromExtension({ id, result: null });
      return;
    }
  }
  toExtension({ ...request, id });
}

function onConnection(socket: Socket): void {
  const client: Client = { socket, watched: new Set() };
  clients.add(client);
  socket.on(
    'data',
    lines((request: Request) => fromClient(client, request)),
  );
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    clients.delete(client);
    for (const [id, request] of pending) if (request.client === client) pending.delete(id);
    for (const tabId of client.watched) {
      if (watchers(tabId) === 0) toExtension({ id: ++nextId, op: 'unwatch', tabId });
    }
  });
}

mkdirSync(CUE_DIR, { recursive: true, mode: 0o700 });
rmSync(path, { force: true });
const server = createServer(onConnection).listen(path, () => chmodSync(path, 0o600));

process.stdin.on('data', frames(fromExtension));
process.stdin.on('end', () => {
  server.close();
  rmSync(path, { force: true });
  process.exit(0);
});
