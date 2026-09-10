'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { resolveTtsPath, TTS_SCHEME } = loadTs('src/main/ttsProtocol.ts');

const base = path.resolve('/models/tts');

test('a model file resolves inside the model directory', () => {
  const p = resolveTtsPath(base, `${TTS_SCHEME}://model/onnx/model_quantized.onnx`);
  assert.equal(p, path.join(base, 'onnx', 'model_quantized.onnx'));
});

test('a voice pack resolves', () => {
  const p = resolveTtsPath(base, `${TTS_SCHEME}://model/voices/af_sarah.bin`);
  assert.equal(p, path.join(base, 'voices', 'af_sarah.bin'));
});

test('directory traversal is refused', () => {
  assert.equal(resolveTtsPath(base, `${TTS_SCHEME}://model/../../secrets.env`), null);
  assert.equal(resolveTtsPath(base, `${TTS_SCHEME}://model/onnx/../../../etc/passwd`), null);
});

test('no request can resolve outside the model directory', () => {
  // The invariant that matters is containment, not any particular rejection.
  // The URL parser already collapses dot segments (including the %2e form), so
  // some of these normalise to a harmless in-directory path rather than being
  // refused — either outcome is fine, escaping is not.
  const attempts = [
    `${TTS_SCHEME}://model/%2e%2e/%2e%2e/other.bin`,
    `${TTS_SCHEME}://model/..%2f..%2fother.bin`,
    `${TTS_SCHEME}://model/voices/../../../../other.bin`,
    `${TTS_SCHEME}://model/./voices/./af_sarah.bin`
  ];
  for (const url of attempts) {
    const p = resolveTtsPath(base, url);
    if (p === null) continue;
    const within = path.relative(base, p);
    assert.ok(
      within && !within.startsWith('..') && !path.isAbsolute(within),
      `${url} escaped the model directory: ${p}`
    );
  }
});

test('the staged onnxruntime runtime is servable', () => {
  // transformers.js otherwise pulls these from a jsdelivr CDN, which would put a
  // network fetch on startup; they are staged under ort/ instead.
  for (const file of ['ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.jsep.mjs']) {
    assert.equal(
      resolveTtsPath(base, `${TTS_SCHEME}://model/${file}`),
      path.join(base, ...file.split('/'))
    );
  }
});

test('an unexpected extension is refused', () => {
  assert.equal(resolveTtsPath(base, `${TTS_SCHEME}://model/run.exe`), null);
});
