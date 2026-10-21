// The ship duel's sound (src/duelAudio.js, src/duelAssets.js): the embedded effects are real mp3s and the module is safe
// without a browser audio context.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('the duel sounds', () => {
  it('embeds three mp3 effects, each of a plausible size', async () => {
    const A = await import('../src/duelAssets.js');
    for (const k of ['GUN', 'HIT', 'SINK']) {
      const bytes = Buffer.from(A[k], 'base64');
      assert.equal(bytes.subarray(0, 3).toString(), 'ID3', `${k} is an mp3`);
      assert.ok(bytes.length > 10_000 && bytes.length < 120_000, `${k}: ${bytes.length} bytes`);
    }
  });

  it('is silent and unsupported without an audio context, and does not throw', async () => {
    globalThis.window = { addEventListener() {} };
    const { createDuelAudio } = await import('../src/duelAudio.js');
    const a = createDuelAudio();
    assert.equal(a.supported, false);
    a.setEnabled(true);
    a.event({ type: 'shot', pos: [0, 0, 0] });
    a.update({ ships: [] }, { position: { x: 0, y: 0, z: 0 } });
    delete globalThis.window;
  });
});
