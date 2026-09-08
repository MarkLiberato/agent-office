'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { cacheKey, normalizeText, TtsCache, InFlight } =
  loadTs('src/renderer/src/audio/ttsCache.ts');

test('keys ignore surrounding whitespace and case', () => {
  assert.equal(cacheKey('af_sarah', '  Is it Pretzel Day?  '), cacheKey('af_sarah', 'is it pretzel day?'));
});

test('keys separate voices', () => {
  assert.notEqual(cacheKey('af_sarah', 'hello'), cacheKey('am_adam', 'hello'));
});

test('keys separate speaking speeds', () => {
  assert.notEqual(cacheKey('af_sarah', 'hello', 0.96), cacheKey('af_sarah', 'hello', 1.04));
});

test('the god token is resolved before keying, not after', () => {
  // Lines carry a {god} placeholder; two different bosses must not share a clip.
  assert.notEqual(normalizeText('do NOT tell Mark I am in here'), normalizeText('do NOT tell Dwight I am in here'));
});

test('the cache evicts least-recently-used at capacity', () => {
  const c = new TtsCache(2);
  c.set('a', 1); c.set('b', 2);
  c.get('a');            // 'a' is now the most recent, so 'b' is next out
  c.set('c', 3);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('c'), true);
  assert.equal(c.size, 2);
});

test('two concurrent requests for one key synthesize once', async () => {
  const flight = new InFlight();
  let calls = 0;
  const make = () => { calls++; return new Promise((r) => setTimeout(() => r('pcm'), 10)); };
  const [x, y] = await Promise.all([flight.run('k', make), flight.run('k', make)]);
  assert.equal(calls, 1);
  assert.equal(x, 'pcm');
  assert.equal(y, 'pcm');
  assert.equal(flight.pending, 0);
});

test('a failed synthesis is not left pending', async () => {
  const flight = new InFlight();
  await assert.rejects(flight.run('k', async () => { throw new Error('boom'); }));
  assert.equal(flight.pending, 0);
});

test('byte-bounded cache rejects one oversized PCM and evicts old audio', () => {
  const c = new TtsCache(10, { maxBytes: 8, byteSize: (v) => v.byteLength });
  c.set('big', new Uint8Array(9));
  assert.equal(c.size, 0);
  c.set('a', new Uint8Array(5));
  c.set('b', new Uint8Array(4));
  c.set('c', new Uint8Array(4));
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
  assert.equal(c.has('c'), true);
});
