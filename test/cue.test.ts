import { describe, expect, test } from 'bun:test';

import {
  createCue,
  type Source,
  type TabEvent,
  TabNotFoundError,
  type TabState,
} from '../src/index.ts';

const page = (url: string, extra: Partial<TabState> = {}): TabState => ({
  url,
  title: url,
  loading: false,
  focused: false,
  ...extra,
});

/** A source whose events the test fires by hand. */
function fakeSource(initial: TabState | undefined) {
  let listener: ((event: TabEvent) => void) | undefined;
  let watching = false;
  const source: Source = {
    getTab: async () => initial,
    watch(_tabId, l) {
      listener = l;
      watching = true;
      return () => {
        watching = false;
      };
    },
  };
  return {
    source,
    emit: (event: TabEvent) => listener?.(event),
    isWatching: () => watching,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fast = { settleMs: 20, timeoutMs: 500 };

describe('cue', () => {
  test('wakes settled once a navigation stays quiet', async () => {
    const tab = fakeSource(page('https://site.test/login'));
    const waiting = createCue(tab.source)(1, fast);
    await sleep(0);
    tab.emit({ type: 'updated', state: page('https://site.test/home') });

    const result = await waiting;
    expect(result.wake).toBe('settled');
    expect(result.url).toBe('https://site.test/home');
    expect(result.since.navigations).toBe(1);
    expect(tab.isWatching()).toBe(false);
  });

  test('a redirect chain wakes once, at the end', async () => {
    const tab = fakeSource(page('https://site.test/login'));
    const waiting = createCue(tab.source)(1, fast);
    await sleep(0);
    tab.emit({ type: 'updated', state: page('https://sso.test/cb', { loading: true }) });
    await sleep(30);
    tab.emit({ type: 'updated', state: page('https://site.test/home') });

    const result = await waiting;
    expect(result.url).toBe('https://site.test/home');
    expect(result.since.navigations).toBe(2);
  });

  test('wakes left only after the human visited the tab', async () => {
    const tab = fakeSource(page('https://site.test/login'));
    const waiting = createCue(tab.source)(1, fast);
    await sleep(0);
    tab.emit({ type: 'attention', focused: false });
    tab.emit({ type: 'attention', focused: true });
    await sleep(10);
    tab.emit({ type: 'attention', focused: false });

    const result = await waiting;
    expect(result.wake).toBe('left');
    expect(result.since.focusedMs).toBeGreaterThanOrEqual(5);
  });

  test('wakes closed when the tab goes away', async () => {
    const tab = fakeSource(page('https://site.test/login'));
    const waiting = createCue(tab.source)(1, fast);
    await sleep(0);
    tab.emit({ type: 'removed' });
    expect((await waiting).wake).toBe('closed');
  });

  test('wakes timeout when nothing happens', async () => {
    const tab = fakeSource(page('https://site.test/login'));
    const result = await createCue(tab.source)(1, { settleMs: 20, timeoutMs: 30 });
    expect(result.wake).toBe('timeout');
    expect(result.since.navigations).toBe(0);
  });

  test('rejects with the abort reason and stops watching', async () => {
    const tab = fakeSource(page('https://site.test/login'));
    const controller = new AbortController();
    const waiting = createCue(tab.source)(1, { ...fast, signal: controller.signal });
    await sleep(0);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(tab.isWatching()).toBe(false);
  });

  test('rejects TabNotFoundError for a missing tab', async () => {
    const tab = fakeSource(undefined);
    await expect(createCue(tab.source)(7, fast)).rejects.toBeInstanceOf(TabNotFoundError);
  });

  test('handles a source that emits inside watch()', async () => {
    const source: Source = {
      getTab: async () => page('https://site.test/login'),
      watch(_id, listener) {
        listener({ type: 'removed' });
        return () => {};
      },
    };
    expect((await createCue(source)(1, fast)).wake).toBe('closed');
  });
});
