'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { isSpeakable, PRIORITY_RANK, MAX_SPOKEN_CHARS } =
  loadTs('src/renderer/src/audio/speechIntent.ts');

test('ordinary banter is speakable', () => {
  assert.equal(isSpeakable('is this decaf? who did this'), true);
  assert.equal(isSpeakable('big day. lots of meetings.'), true);
});

test('empty and overlong text is refused', () => {
  assert.equal(isSpeakable(''), false);
  assert.equal(isSpeakable('   '), false);
  assert.equal(isSpeakable('x'.repeat(MAX_SPOKEN_CHARS + 1)), false);
});

// The guard is the last line of defence, not the first: nothing should ever hand
// it work data. These are the shapes that would mean a leak happened upstream.
test('work data never passes the guard', () => {
  const leaks = [
    'edit src/renderer/src/App.tsx',
    'bash npm test',
    'C:\\Users\\AnjMark\\Documents\\Projects\\office-agent',
    'https://hooks.slack.com/services/T000/B000/xyz',
    'read ~/.claude/settings.json',
    'error: ENOENT no such file or directory',
    'sk-ant-api03-abcdefghijklmnop',
    'subject: Q3 revenue plan',
    'commit 3e4f9f6 merged into main',
    '<@U0123ABC> can you look at this',
    'const x = await fetch(url)'
  ];
  for (const leak of leaks) {
    assert.equal(isSpeakable(leak), false, `must not speak: ${leak}`);
  }
});

test('conversation beats outrank reactions, which outrank ambient chatter', () => {
  assert.ok(PRIORITY_RANK.conversation < PRIORITY_RANK.reaction);
  assert.ok(PRIORITY_RANK.reaction < PRIORITY_RANK.ambient);
});
