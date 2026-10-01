/**
 * A cue Source backed by the chrome.tabs and chrome.windows extension APIs.
 * Needs the "tabs" permission. Does not use chrome.debugger, so it works on tabs another
 * extension is already debugging.
 */

import type { Source, TabEvent, TabState } from './index.js';

/** The slice of the extension API this source uses. Pass a fake in tests. */
export interface ChromeApi {
  tabs: {
    get(tabId: number): Promise<chrome.tabs.Tab>;
    onUpdated: chrome.events.Event<
      (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
    >;
    onRemoved: chrome.events.Event<(tabId: number) => void>;
    onActivated: chrome.events.Event<(info: { tabId: number; windowId: number }) => void>;
  };
  windows: {
    get(windowId: number): Promise<chrome.windows.Window>;
    onFocusChanged: chrome.events.Event<(windowId: number) => void>;
  };
}

export function chromeSource(api: ChromeApi = chrome): Source {
  const read = async (tabId: number): Promise<TabState | undefined> => {
    const tab = await api.tabs.get(tabId).catch(() => undefined);
    if (!tab) return undefined;
    const window = await api.windows.get(tab.windowId).catch(() => undefined);
    return toState(tab, Boolean(tab.active && window?.focused));
  };

  return {
    getTab: read,

    watch(tabId, listener) {
      let focused: boolean | undefined;
      let stopped = false;
      const emit = (event: TabEvent) => {
        if (!stopped) listener(event);
      };

      // Activation and window focus say nothing about which tab they concern,
      // so re-read the tab and emit only when its attention actually changes.
      const recheck = async () => {
        const state = await read(tabId);
        if (!state || stopped || state.focused === focused) return;
        const first = focused === undefined;
        focused = state.focused;
        if (!first) emit({ type: 'attention', focused: state.focused });
      };

      const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
        if (id !== tabId) return;
        if (change.url === undefined && change.title === undefined && change.status === undefined)
          return;
        emit({ type: 'updated', state: toState(tab, focused ?? false) });
      };
      const onRemoved = (id: number) => {
        if (id === tabId) emit({ type: 'removed' });
      };

      api.tabs.onUpdated.addListener(onUpdated);
      api.tabs.onRemoved.addListener(onRemoved);
      api.tabs.onActivated.addListener(recheck);
      api.windows.onFocusChanged.addListener(recheck);
      void recheck();

      return () => {
        stopped = true;
        api.tabs.onUpdated.removeListener(onUpdated);
        api.tabs.onRemoved.removeListener(onRemoved);
        api.tabs.onActivated.removeListener(recheck);
        api.windows.onFocusChanged.removeListener(recheck);
      };
    },
  };
}

function toState(tab: chrome.tabs.Tab, focused: boolean): TabState {
  return {
    url: tab.url ?? tab.pendingUrl ?? '',
    title: tab.title ?? '',
    loading: tab.status === 'loading',
    focused,
  };
}
