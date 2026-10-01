/**
 * cue: wait for a human to take their turn in a browser tab.
 *
 * cue only signals that something worth a second look happened. It never decides whether the
 * human finished. The agent looks at the tab again and calls cue once more if it is still blocked.
 */

/** What the human is doing with a tab, as far as the browser can tell. */
export interface TabState {
  url: string;
  title: string;
  loading: boolean;
  /** The tab is the active tab of the focused browser window. */
  focused: boolean;
}

/** A change to one watched tab. Sources emit only these three kinds. */
export type TabEvent =
  | { type: 'updated'; state: TabState }
  | { type: 'attention'; focused: boolean }
  | { type: 'removed' };

/** Where tab events come from. Implement this to run cue on anything other than Chrome. */
export interface Source {
  /** The tab's current state, or `undefined` if it does not exist. */
  getTab(tabId: number): Promise<TabState | undefined>;
  /** Deliver events for one tab until the returned function is called. */
  watch(tabId: number, listener: (event: TabEvent) => void): () => void;
}

/** Why cue woke the agent. */
export type Wake =
  /** The human visited the tab and then left it. */
  | 'left'
  /** The tab navigated, then stayed still for `settleMs`. */
  | 'settled'
  /** The tab was closed. */
  | 'closed'
  /** Nothing conclusive happened within `timeoutMs`. */
  | 'timeout';

export interface Cue {
  wake: Wake;
  tabId: number;
  url: string;
  title: string;
  /** What happened while waiting. Counts only, never page content. */
  since: { navigations: number; focusedMs: number };
  waitedMs: number;
}

export interface CueOptions {
  /** Quiet time after a navigation before waking. Default 1500 ms. */
  settleMs?: number;
  /** Longest wait. Default 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class TabNotFoundError extends Error {
  readonly tabId: number;

  constructor(tabId: number) {
    super(`No tab with id ${tabId}`);
    this.name = 'TabNotFoundError';
    this.tabId = tabId;
  }
}

const DEFAULT_SETTLE_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function createCue(source: Source) {
  return async function cue(tabId: number, options: CueOptions = {}): Promise<Cue> {
    const { settleMs = DEFAULT_SETTLE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
    signal?.throwIfAborted();

    const initial = await source.getTab(tabId);
    if (!initial) throw new TabNotFoundError(tabId);
    signal?.throwIfAborted();

    return new Promise<Cue>((resolve, reject) => {
      const startedAt = Date.now();
      let state = initial;
      let navigations = 0;
      let focusedMs = 0;
      let focusedSince = initial.focused ? startedAt : undefined;
      // A tab the human never looked at cannot be "left".
      let visited = initial.focused;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let unwatch = () => {};
      let done = false;

      const finish = (wake: Wake) => {
        if (done) return;
        cleanup();
        const now = Date.now();
        const total = focusedMs + (focusedSince === undefined ? 0 : now - focusedSince);
        resolve({
          wake,
          tabId,
          url: state.url,
          title: state.title,
          since: { navigations, focusedMs: total },
          waitedMs: now - startedAt,
        });
      };

      const onEvent = (event: TabEvent) => {
        if (event.type === 'removed') return finish('closed');

        if (event.type === 'attention') {
          if (event.focused) {
            visited = true;
            focusedSince ??= Date.now();
            return;
          }
          if (focusedSince !== undefined) focusedMs += Date.now() - focusedSince;
          focusedSince = undefined;
          if (visited) finish('left');
          return;
        }

        if (event.state.url !== state.url) navigations++;
        state = event.state;
        // Each update restarts the quiet period, so redirect chains wake once, at the end.
        clearTimeout(settleTimer);
        settleTimer = state.loading ? undefined : setTimeout(() => finish('settled'), settleMs);
      };

      const onAbort = () => {
        if (done) return;
        cleanup();
        reject(signal?.reason);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      timeoutTimer = setTimeout(() => finish('timeout'), timeoutMs);
      unwatch = source.watch(tabId, onEvent);
      // A source may emit synchronously inside watch() and finish before it returns.
      if (done) unwatch();

      function cleanup() {
        done = true;
        unwatch();
        clearTimeout(settleTimer);
        clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
      }
    });
  };
}
