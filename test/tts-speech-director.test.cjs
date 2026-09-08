'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { harness } = require('./fixtures/speech-harness.cjs');

const { SpeechDirector, DIRECTOR_LIMITS } =
  loadTs('src/renderer/src/audio/speechDirector.ts');

test('a queued line plays without anyone calling enqueue again', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'first', agentId: 'a' }));
  d.enqueue(h.intent({ utteranceId: 'second', agentId: 'b' }));
  await h.flush();
  assert.deepEqual(h.log.started.map((s) => s.id), ['first']);

  // This is the regression: the old queue exited its pump inside the post-line
  // gap and only woke on the NEXT speak() call, so 'second' stayed silent.
  await h.advance(5000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['first', 'second']);
});

test('conversation beats play in order however they were queued', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', conversationId: 'c', beatIndex: 1, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', conversationId: 'c', beatIndex: 0, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b2', agentId: 'a', conversationId: 'c', beatIndex: 2, priority: 'conversation' }));
  await h.advance(10000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['b0', 'b1', 'b2']);
});

test('a reply starts inside the 200-450ms window after the previous speaker', async () => {
  const h = harness({ random: 0.5, durations: { b0: 1200 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', conversationId: 'c', beatIndex: 0, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', conversationId: 'c', beatIndex: 1, priority: 'conversation' }));
  await h.advance(6000);

  const endOfFirst = h.log.ended.find((e) => e.id === 'b0').at;
  const startOfReply = h.log.started.find((s) => s.id === 'b1').at;
  const gap = startOfReply - endOfFirst;
  assert.ok(gap >= DIRECTOR_LIMITS.replyGapMinMs, `gap ${gap} too short`);
  assert.ok(gap <= DIRECTOR_LIMITS.replyGapMaxMs, `gap ${gap} too long`);
});

test('the next turn is synthesized while the current one is still playing', async () => {
  const h = harness({ durations: { b0: 2000 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', conversationId: 'c', beatIndex: 0, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', conversationId: 'c', beatIndex: 1, priority: 'conversation' }));
  await h.flush();
  assert.deepEqual(h.log.prepared, ['b1'], 'the reply is prepared during beat 0');
  assert.deepEqual(h.log.started.map((s) => s.id), ['b0'], 'but not started early');
});

test('onStart carries the real clip length and onEnd waits for the audio', async () => {
  const h = harness({ durations: { solo: 1800 } });
  const d = new SpeechDirector(h.sink, h.clock);
  let startedWith = null;
  let endedAt = null;
  d.enqueue(h.intent({
    utteranceId: 'solo',
    onStart: (ms) => { startedWith = ms; },
    onEnd: () => { endedAt = h.at(); }
  }));
  await h.flush();
  assert.equal(startedWith, 1800, 'the caption is told the true duration');
  assert.equal(endedAt, null, 'and is not torn down before the audio finishes');
  await h.advance(1800);
  assert.equal(endedAt, 2800);
});

test('a beat that arrives before its predecessor waits its turn', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  // Beat 1 alone: it is the only pending beat of its conversation, but a
  // conversation always starts at beat 0, so nothing should speak.
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', conversationId: 'c', beatIndex: 1, priority: 'conversation' }));
  await h.advance(5000);
  assert.deepEqual(h.log.started, [], 'a conversation cannot open on beat 1');

  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', conversationId: 'c', beatIndex: 0, priority: 'conversation' }));
  await h.advance(5000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['b0', 'b1']);
});
