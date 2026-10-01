// A cue Source that talks to the reference extension through the native host's socket.

import { connect, type Socket } from 'node:net';

import type { Source, TabEvent, TabState } from '../../src/index.ts';
import type { Message, Request, TabSummary } from './protocol.ts';
import { lines, socketPath } from './wire.ts';

type Op = Request extends infer R ? (R extends { op: infer O } ? O : never) : never;

export interface RemoteSource extends Source {
  tabs(): Promise<TabSummary[]>;
  close(): void;
}

export function remoteSource(browser = 'chrome'): Promise<RemoteSource> {
  const path = socketPath(browser);
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('error', () =>
      reject(new Error(`cue is not running for ${browser}. Is the extension loaded?`)),
    );
    socket.once('connect', () => resolve(wrap(socket)));
  });
}

function wrap(socket: Socket): RemoteSource {
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Map<number, Set<(event: TabEvent) => void>>();

  socket.on(
    'data',
    lines((message: Message) => {
      if ('event' in message) {
        for (const listener of listeners.get(message.tabId) ?? []) listener(message.event);
        return;
      }
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.result);
    }),
  );
  socket.on('close', () => {
    for (const request of pending.values()) request.reject(new Error('cue host closed'));
    pending.clear();
  });

  const call = <T>(op: Op, tabId?: number): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, op, tabId })}\n`);
    });

  return {
    getTab: async (tabId) => (await call<TabState | null>('getTab', tabId)) ?? undefined,
    watch(tabId, listener) {
      let set = listeners.get(tabId);
      if (!set) {
        set = new Set();
        listeners.set(tabId, set);
        void call('watch', tabId).catch(() => {});
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size > 0) return;
        listeners.delete(tabId);
        if (!socket.destroyed) void call('unwatch', tabId).catch(() => {});
      };
    },
    tabs: () => call<TabSummary[]>('tabs'),
    close: () => socket.end(),
  };
}
