'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HiveSpeechBroker, HIVE_SPEECH_HISTORY_LIMIT, isConfirmedHiveDelivery } =
  loadTs('src/renderer/src/audio/hiveSpeechCues.ts');

const event = (over = {}) => ({
  id: 'm1', conversation: 'c1', inReplyTo: null, from: 'a',
  deliveredTargets: ['b'], act: 'request', requiresReply: true, needsHuman: false,
  ...over
});

test('malformed or unconfirmed delivery metadata fails closed', () => {
  const broker = new HiveSpeechBroker();
  assert.equal(isConfirmedHiveDelivery(event({ deliveredTargets: [] })), false);
  assert.equal(broker.accept(event({ act: 'invented' })), null);
  assert.equal(broker.accept(event({ deliveredTargets: ['a'] })), null);
});

test('a delivered event speaks once even when it was a broadcast', () => {
  const broker = new HiveSpeechBroker();
  const input = event({ deliveredTargets: ['b', 'c', 'd'], act: 'inform', requiresReply: false });
  const cue = broker.accept(input);
  assert.ok(cue);
  assert.equal(cue.agentId, 'a');
  assert.equal(cue.priority, 'reaction');
  assert.equal(cue.beatIndex, 0);
  assert.equal(broker.accept(input), null, 'the event id is session-deduped');
});

test('a real reverse delivery becomes the next turn only after the first line was accepted', () => {
  const broker = new HiveSpeechBroker();
  const first = broker.accept(event());
  assert.equal(first.priority, 'conversation');
  assert.equal(first.beatIndex, 0);

  const replyInput = event({
    id: 'm2', inReplyTo: 'm1', from: 'b', deliveredTargets: ['a'],
    act: 'agree', requiresReply: false
  });
  const unheardReply = broker.accept(replyInput);
  assert.equal(unheardReply.beatIndex, 0, 'an unheard first cue cannot create an imaginary reply beat');

  const live = new HiveSpeechBroker();
  const liveFirst = live.accept(event());
  live.markSpoken(liveFirst.eventId);
  const realReply = live.accept(replyInput);
  assert.equal(realReply.conversationId, liveFirst.conversationId);
  assert.equal(realReply.beatIndex, 1);
  assert.equal(realReply.agentId, 'b');
});

test('same conversation is insufficient without reverse sender and target direction', () => {
  const broker = new HiveSpeechBroker();
  const first = broker.accept(event());
  broker.markSpoken(first.eventId);
  const unrelated = broker.accept(event({
    id: 'm3', from: 'c', deliveredTargets: ['d'], act: 'done', requiresReply: false
  }));
  assert.equal(unrelated.beatIndex, 0);
});

test('a real reply to one broadcast recipient is still an honest next turn', () => {
  const broker = new HiveSpeechBroker();
  const first = broker.accept(event({
    deliveredTargets: ['b', 'c'], act: 'inform', requiresReply: false
  }));
  broker.markSpoken(first.eventId);
  const reply = broker.accept(event({
    id: 'm4', inReplyTo: 'm1', from: 'c', deliveredTargets: ['a'],
    act: 'agree', requiresReply: false
  }));
  assert.equal(reply.priority, 'conversation');
  assert.equal(reply.conversationId, first.conversationId);
  assert.equal(reply.beatIndex, 1);
});

test('spoken text is catalog-only and never interpolates event metadata', () => {
  const broker = new HiveSpeechBroker();
  const cue = broker.accept(event({ id: 'secret-event', conversation: 'secret-conversation', from: 'secret-sender' }));
  assert.ok(!cue.text.includes('secret'));
});

test('session dedupe and correlation memory stays bounded', () => {
  const broker = new HiveSpeechBroker();
  for (let i = 0; i < HIVE_SPEECH_HISTORY_LIMIT + 20; i++) {
    broker.accept(event({ id: `m${i}`, conversation: `c${i}` }));
  }
  assert.equal(broker.historySize, HIVE_SPEECH_HISTORY_LIMIT);
});
