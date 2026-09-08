'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { voiceForAgent, speechProfileForAgent, FALLBACK_VOICES } = loadTs('src/renderer/src/audio/voiceCast.ts');
const { OFFICE_CAST } = loadTs('src/renderer/src/scene/office/cast.ts');

test('every cast member has a distinct voice', () => {
  const voices = OFFICE_CAST.map((c) => c.voice);
  assert.equal(voices.filter(Boolean).length, OFFICE_CAST.length, 'a cast member is missing a voice');
  assert.equal(new Set(voices).size, voices.length, 'two cast members share a voice');
});

test('a cast character always gets its cast voice', () => {
  assert.equal(voiceForAgent({ character: 'dwight', agentId: 'a1' }), 'am_fenrir');
  assert.equal(voiceForAgent({ character: 'pam', agentId: 'zz' }), 'af_sarah');
});

test('the god role never gets a floor voice', () => {
  assert.equal(voiceForAgent({ character: 'michael', agentId: 'a1', isGod: true }), null);
});

test('off-roster agents get a stable hashed voice', () => {
  const first = voiceForAgent({ character: null, agentId: 'agent-1234' });
  const again = voiceForAgent({ character: null, agentId: 'agent-1234' });
  assert.equal(first, again, 'the same agent must sound the same across restarts');
  assert.ok(FALLBACK_VOICES.includes(first));
});

test('a voice missing from the model falls back instead of throwing', () => {
  const available = FALLBACK_VOICES.filter((v) => v !== 'am_fenrir');
  const v = voiceForAgent({ character: 'dwight', agentId: 'a1', available });
  assert.notEqual(v, 'am_fenrir');
  assert.ok(available.includes(v));
});

test('character speed and gain remain stable and natural', () => {
  const first = speechProfileForAgent({ character: 'dwight', agentId: 'a1' });
  const again = speechProfileForAgent({ character: 'dwight', agentId: 'different-id' });
  assert.deepEqual(first, again);
  assert.ok(first.speed >= 0.9 && first.speed <= 1.1);
  assert.ok(first.gain >= 0.85 && first.gain <= 1);
});
