'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-route-event-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const events = [];
  const hive = new HiveManager(() => home, (channel, payload) => {
    if (channel === 'hive:message') events.push(payload);
    return true;
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { hive, events };
}

test('renderer route event is content-free confirmed-delivery metadata', async (t) => {
  const { hive, events } = await floor(t);

  const msg = hive.send({
    id: 'msg-1',
    conversation: 'conv-1',
    in_reply_to: 'msg-0',
    to: 'jim-1',
    act: 'query',
    subject: 'private subject',
    body: 'private body',
    requires_reply: true,
    needs_human: true
  }, 'god-1');

  assert.equal(msg.id, 'msg-1');
  assert.deepEqual(events, [{
    id: 'msg-1',
    conversation: 'conv-1',
    inReplyTo: 'msg-0',
    from: 'god-1',
    deliveredTargets: ['jim-1'],
    act: 'query',
    requiresReply: true,
    needsHuman: true
  }]);
  assert.equal('subject' in events[0], false);
  assert.equal('body' in events[0], false);
  assert.equal('to' in events[0], false);
  assert.equal('targets' in events[0], false);
});

test('renderer route event omits intended recipients that did not receive mail', async (t) => {
  const { hive, events } = await floor(t);

  hive.send({ to: 'missing-agent', act: 'request', subject: 'will bounce' }, 'jim-1');

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].deliveredTargets, []);
  assert.equal(events[0].requiresReply, true);
});

test('human-addressed mail is marked without exposing the intended address', async (t) => {
  const { hive, events } = await floor(t);

  hive.send({ to: 'human', act: 'inform', subject: 'heads up' }, 'jim-1');

  assert.deepEqual(events[0].deliveredTargets, ['god-1']);
  assert.equal(events[0].needsHuman, true);
  assert.equal('to' in events[0], false);
});
