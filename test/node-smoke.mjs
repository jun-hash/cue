// Runs the built package under plain Node to prove it needs no Bun APIs.
import assert from 'node:assert/strict';
import { chromeSource } from '../dist/chrome.js';
import { createCue, TabNotFoundError } from '../dist/index.js';

assert.equal(typeof chromeSource, 'function');
const cue = createCue({ getTab: async () => undefined, watch: () => () => {} });
await assert.rejects(cue(1), TabNotFoundError);

const settled = await createCue({
  getTab: async () => ({ url: 'a', title: 'a', loading: false, focused: false }),
  watch(_id, emit) {
    setTimeout(
      () =>
        emit({ type: 'updated', state: { url: 'b', title: 'b', loading: false, focused: false } }),
      5,
    );
    return () => {};
  },
})(1, { settleMs: 10 });
assert.equal(settled.wake, 'settled');
console.log('node smoke: ok');
