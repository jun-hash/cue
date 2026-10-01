import { expect, test } from 'bun:test';

import { type ChromeApi, chromeSource } from '../src/chrome.ts';
import type { TabEvent } from '../src/index.ts';

/** Minimal chrome.events.Event stand-in. */
function event<F extends (...args: any[]) => void>() {
  const listeners = new Set<F>();
  return {
    addListener: (f: F) => listeners.add(f),
    removeListener: (f: F) => listeners.delete(f),
    fire: (...args: Parameters<F>) => {
      for (const f of listeners) f(...args);
    },
    count: () => listeners.size,
  };
}

function fakeChrome() {
  const tabs = new Map<number, chrome.tabs.Tab>();
  const windows = new Map<number, { focused: boolean }>();
  const e = {
    updated: event<(id: number, c: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) => void>(),
    removed: event<(id: number) => void>(),
    activated: event<(info: { tabId: number; windowId: number }) => void>(),
    focus: event<(windowId: number) => void>(),
  };
  const api = {
    tabs: {
      get: async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      onUpdated: e.updated,
      onRemoved: e.removed,
      onActivated: e.activated,
    },
    windows: {
      get: async (id: number) => windows.get(id) ?? { focused: false },
      onFocusChanged: e.focus,
    },
  } as unknown as ChromeApi;
  return { api, tabs, windows, e };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tab = (id: number, extra: Partial<chrome.tabs.Tab> = {}) =>
  ({
    id,
    windowId: 1,
    active: false,
    url: 'https://a.test/',
    title: 'A',
    status: 'complete',
    ...extra,
  }) as chrome.tabs.Tab;

test('getTab reports focus only for the active tab of a focused window', async () => {
  const c = fakeChrome();
  c.tabs.set(1, tab(1, { active: true }));
  c.windows.set(1, { focused: true });
  const source = chromeSource(c.api);
  expect((await source.getTab(1))?.focused).toBe(true);

  c.windows.set(1, { focused: false });
  expect((await source.getTab(1))?.focused).toBe(false);
  expect(await source.getTab(99)).toBeUndefined();
});

test('watch forwards updates and removal for its tab only', async () => {
  const c = fakeChrome();
  c.tabs.set(1, tab(1));
  const seen: TabEvent[] = [];
  const stop = chromeSource(c.api).watch(1, (event) => seen.push(event));
  await tick();

  c.e.updated.fire(2, { url: 'https://b.test/' }, tab(2));
  c.e.updated.fire(1, { favIconUrl: 'x' }, tab(1));
  c.e.updated.fire(1, { url: 'https://a.test/home' }, tab(1, { url: 'https://a.test/home' }));
  c.e.removed.fire(2);
  c.e.removed.fire(1);

  expect(seen.map((event) => event.type)).toEqual(['updated', 'removed']);
  stop();
  expect(c.e.updated.count()).toBe(0);
  expect(c.e.focus.count()).toBe(0);
});

test('watch emits attention when the human enters and leaves the tab', async () => {
  const c = fakeChrome();
  c.tabs.set(1, tab(1));
  c.windows.set(1, { focused: true });
  const seen: TabEvent[] = [];
  chromeSource(c.api).watch(1, (event) => seen.push(event));
  await tick();

  c.tabs.set(1, tab(1, { active: true }));
  c.e.activated.fire({ tabId: 1, windowId: 1 });
  await tick();
  c.windows.set(1, { focused: false });
  c.e.focus.fire(-1);
  await tick();
  c.e.focus.fire(-1);
  await tick();

  expect(seen).toEqual([
    { type: 'attention', focused: true },
    { type: 'attention', focused: false },
  ]);
});
