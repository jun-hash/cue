// Messages between the MCP server and the extension, relayed by the native host.
//
//   mcp.ts ──Unix socket, JSON lines──▶ host.ts ──native messaging──▶ extension
//
// The extension only answers getTab and streams events for watched tabs. All waiting logic
// runs in the MCP server, so nothing is lost if Chrome suspends the extension's service worker.
// This file is shared with the extension, so it must stay free of Node APIs.

import type { TabEvent, TabState } from '../../src/index.ts';

export const HOST_NAME = 'dev.junhash.cue';

/** Fixed by the `key` in extension/manifest.json. */
export const EXTENSION_ID = 'mdbecacfaknhhjiiaidadpeapkpmcacd';

export type Request =
  | { id: number; op: 'getTab'; tabId: number }
  | { id: number; op: 'watch'; tabId: number }
  | { id: number; op: 'unwatch'; tabId: number }
  /** Lists tabs. Used by tests to find a tab by URL; agents get tab ids from their own tools. */
  | { id: number; op: 'tabs' };

export type Reply = { id: number; result?: unknown; error?: string };
export type Push = { tabId: number; event: TabEvent };
export type Message = Reply | Push;

export type TabSummary = { id: number; url: string; title: string };
export type { TabState };
