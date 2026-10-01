// Reference extension: serves chromeSource() to the native host. Built to background.js.

import { chromeSource } from '../../../src/chrome.ts';
import { HOST_NAME, type Request } from '../protocol.ts';

const RECONNECT_MS = 5_000;
const source = chromeSource();
const watching = new Map<number, () => void>();

let port: chrome.runtime.Port | undefined;

async function handle(request: Request): Promise<unknown> {
  switch (request.op) {
    case 'getTab':
      return (await source.getTab(request.tabId)) ?? null;
    case 'watch':
      if (!watching.has(request.tabId)) {
        const stop = source.watch(request.tabId, (event) =>
          port?.postMessage({ tabId: request.tabId, event }),
        );
        watching.set(request.tabId, stop);
      }
      return null;
    case 'unwatch':
      watching.get(request.tabId)?.();
      watching.delete(request.tabId);
      return null;
    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((tab) => ({ id: tab.id, url: tab.url ?? '', title: tab.title ?? '' }));
    }
  }
}

function connect(): void {
  if (port) return;
  const current = chrome.runtime.connectNative(HOST_NAME);
  port = current;
  current.onMessage.addListener(async (request: Request) => {
    try {
      current.postMessage({ id: request.id, result: await handle(request) });
    } catch (error) {
      current.postMessage({ id: request.id, error: String(error) });
    }
  });
  current.onDisconnect.addListener(() => {
    for (const stop of watching.values()) stop();
    watching.clear();
    port = undefined;
    setTimeout(connect, RECONNECT_MS);
  });
}

// Registering this wakes the service worker when the browser starts.
chrome.runtime.onStartup.addListener(connect);
connect();
