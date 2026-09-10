'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fetchVoices = require('../tools/fetch-voices.cjs');

test('the manifest names the quantized model, never fp32', () => {
  assert.equal(fetchVoices.MODEL_REPO, 'onnx-community/Kokoro-82M-v1.0-ONNX');
  assert.ok(fetchVoices.FILES.includes('onnx/model_quantized.onnx'));
  assert.ok(!fetchVoices.FILES.some((f) => f.includes('model.onnx')));
});

test('every cast voice is in the fetch list', () => {
  const cast = [
    'am_michael', 'am_adam', 'am_fenrir', 'am_puck', 'am_eric', 'am_onyx',
    'am_liam', 'am_santa', 'am_echo', 'bm_lewis',
    'af_sarah', 'af_kore', 'af_nicole', 'af_nova', 'af_bella'
  ];
  for (const v of cast) assert.ok(fetchVoices.VOICES.includes(v), `missing voice ${v}`);
});

test('model weights are gitignored', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^resources\/tts\/?$/m);
});

test('electron-builder ships the model as an extra resource', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /from:\s*resources\/tts/);
  assert.match(yml, /to:\s*tts/);
});

test('the onnxruntime wasm is staged locally, not pulled from a CDN', () => {
  // transformers.js defaults wasmPaths to jsdelivr; leaving that would put a
  // network fetch on startup and break the app offline.
  const worker = fs.readFileSync(path.join(root, 'src/renderer/src/audio/ttsWorker.ts'), 'utf8');
  assert.match(worker, /wasmPaths\s*=\s*`\$\{MODEL_ORIGIN\}\/ort\//);
  for (const file of fetchVoices.ORT_FILES) {
    const p = path.join(root, 'resources', 'tts', 'ort', file);
    assert.ok(fs.existsSync(p) && fs.statSync(p).size > 0, `missing staged runtime ${file}`);
  }
});

test('every ambience clip named in code exists on disk', () => {
  // ambience.ts uses import.meta.glob, which only exists under Vite, so the
  // filenames are read out of the source rather than by importing it.
  const src = fs.readFileSync(path.join(root, 'src/renderer/src/audio/ambience.ts'), 'utf8');
  const named = [...src.matchAll(/'([a-z0-9-]+\.wav)'/g)].map((m) => m[1]);
  assert.ok(named.length >= 8, `expected the full clip set, found ${named.length}`);
  for (const file of new Set(named)) {
    const p = path.join(root, 'src/renderer/src/assets/audio', file);
    assert.ok(fs.existsSync(p), `missing ambience asset ${file}`);
    assert.ok(fs.statSync(p).size > 0, `empty ambience asset ${file}`);
  }
});

test('the generator produces exactly the clips the code asks for', () => {
  const { CLIPS } = require('../tools/make-ambience.cjs');
  const src = fs.readFileSync(path.join(root, 'src/renderer/src/audio/ambience.ts'), 'utf8');
  const named = new Set([...src.matchAll(/'([a-z0-9-]+\.wav)'/g)].map((m) => m[1]));
  for (const file of named) {
    assert.ok(CLIPS.includes(file), `${file} is referenced but tools/make-ambience.cjs never makes it`);
  }
});
