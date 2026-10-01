# cue

Wait for a human to take their turn in a browser tab.

Your agent reaches a sign-in page. It asks you to log in, then waits for you to type "done".
cue removes the "done": the agent calls `cue(tabId)`, you log in, the agent wakes up.

```ts
import { createCue } from '@jun-hash/cue';
import { chromeSource } from '@jun-hash/cue/chrome';

const cue = createCue(chromeSource()); // in an extension with the "tabs" permission

const { wake, url } = await cue(tabId);
```

## How it decides

It doesn't. cue never judges whether you finished. It wakes the agent when something worth a
second look happens, and the agent looks again. If the tab is still blocked, the agent calls cue
again. An early wake costs one extra look, so the rules can stay simple.

| `wake`    | When                                                    |
| --------- | ------------------------------------------------------- |
| `settled` | The tab navigated, then stayed still for `settleMs`     |
| `left`    | You visited the tab, then switched to another tab or app |
| `closed`  | The tab closed                                          |
| `timeout` | Nothing happened within `timeoutMs`                     |

This covers sign-in, 2FA, CAPTCHAs and payment approvals the same way. cue has no idea which one
it is waiting on.

## API

```ts
createCue(source: Source): (tabId: number, options?: CueOptions) => Promise<Cue>
```

| Option      | Default    |                                        |
| ----------- | ---------- | -------------------------------------- |
| `settleMs`  | `1500`     | Quiet time after a navigation          |
| `timeoutMs` | `600000`   | Longest wait                           |
| `signal`    |            | `AbortSignal` to stop waiting          |

```ts
interface Cue {
  wake: 'settled' | 'left' | 'closed' | 'timeout';
  tabId: number;
  url: string;
  title: string;
  since: { navigations: number; focusedMs: number };
  waitedMs: number;
}
```

`cue` rejects with `TabNotFoundError` if the tab doesn't exist, and with the signal's reason if
aborted.

**`chromeSource(api = chrome)`** reads `chrome.tabs` and `chrome.windows`. It never attaches the
debugger, so it works on tabs that Claude in Chrome or Codex are already driving.

**`Source`** is two methods, `getTab` and `watch`. Implement it to run cue anywhere else.

## Use it with Claude Code or Codex

`examples/reference` is a small extension, a native messaging host and an MCP server with one
tool, `wait_for_human`. Your existing browser extension keeps clicking. This one only waits.

```
Claude Code ──MCP──▶ mcp.ts ──socket──▶ host.ts ──native messaging──▶ extension ──▶ chrome.tabs
```

```sh
git clone https://github.com/jun-hash/cue && cd cue
bun install
bun run reference:install
```

Then load `examples/reference/extension` in `chrome://extensions` (Developer mode → Load
unpacked) and add the MCP server with the command the installer prints. macOS only for now.

## Privacy

cue watches only the tab you pass it, and only while waiting. It reports counts, never page
content. The reference extension asks for `tabs` and `nativeMessaging`, nothing else.

## Develop

```sh
bun install
bun test          # unit tests
bun run e2e       # a throwaway Chrome with the extension; never touches yours
bun run check     # Biome
bun run typecheck
bun run smoke     # the built package under plain Node
```

The library uses web and `node:` APIs only, so it runs in extensions, Node and Bun.

## Status

Not on npm yet. Planned: a CDP source for harnesses that attach over the remote debugging port,
without an extension.

## License

MIT
