#!/usr/bin/env node
'use strict';

// Fetch the Kokoro-82M TTS weights once, at setup, so the app never downloads a
// model while running (the renderer sets allowRemoteModels = false). Mirrors the
// shape of setup-native.cjs: idempotent, safe to re-run, verifies what it wrote.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const manifest = require('./tts-manifest.json');

const MODEL_REPO = manifest.repo;
const FILES = Object.keys(manifest.files);

// The fifteen cast voices (see the spec's casting table) plus the pool the hash
// fallback draws from for off-roster agents.
const VOICES = [
  'am_michael', 'am_adam', 'am_fenrir', 'am_puck', 'am_eric', 'am_onyx',
  'am_liam', 'am_santa', 'am_echo', 'bm_lewis', 'bm_george', 'bm_daniel',
  'af_sarah', 'af_kore', 'af_nicole', 'af_nova', 'af_bella', 'af_heart',
  'bf_emma', 'bf_alice'
];

// onnxruntime-web loads its own WASM runtime, and transformers.js points it at a
// jsdelivr CDN by default. That would put a network fetch on the app's startup
// path, so we stage the runtime beside the weights and aim wasmPaths at it (see
// src/renderer/src/audio/ttsWorker.ts). These are COPIED from node_modules, not
// downloaded — the version must match the installed onnxruntime-web exactly.
const ORT_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm'
];

const ttsDir = () => path.join(root, 'resources', 'tts');

const target = (rel) => path.join(ttsDir(), rel.split('/').join(path.sep));

const allPaths = () => [
  ...FILES,
  ...VOICES.map((v) => `voices/${v}.bin`),
  ...ORT_FILES.map((f) => `ort/${f}`)
];

/** Copy the onnxruntime-web runtime out of node_modules. */
function stageOrt() {
  const dist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
  if (!fs.existsSync(dist)) {
    throw new Error('onnxruntime-web is not installed; run npm install first.');
  }
  const staged = [];
  for (const file of ORT_FILES) {
    const dest = target(`ort/${file}`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const src = path.join(dist, file);
    if (!fs.existsSync(src)) throw new Error(`onnxruntime-web is missing ${file}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    staged.push({ file, bytes: fs.statSync(dest).size });
  }
  return staged;
}

function isComplete() {
  return allPaths().every((rel) => {
    const p = target(rel);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function download(rel) {
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${manifest.revision}/${rel}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${rel}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const expected = manifest.files[rel];
  const actual = sha256(buf);
  if (expected && expected !== actual) {
    throw new Error(`checksum mismatch for ${rel}\n  expected ${expected}\n  actual   ${actual}`);
  }
  const dest = target(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { rel, sha256: actual, bytes: buf.length };
}

async function main() {
  if (isComplete()) {
    console.log('Kokoro TTS model already present — skipping.');
    return;
  }
  console.log(`Fetching ${MODEL_REPO} into resources/tts …`);
  const written = [];
  for (const rel of allPaths()) {
    if (rel.startsWith('ort/')) continue;           // copied, not downloaded
    if (fs.existsSync(target(rel)) && fs.statSync(target(rel)).size > 0) continue;
    const r = await download(rel);
    written.push(r);
    console.log(`  ${r.rel} (${(r.bytes / 1e6).toFixed(1)} MB)`);
  }
  for (const s of stageOrt()) {
    console.log(`  ort/${s.file} (${(s.bytes / 1e6).toFixed(1)} MB, from node_modules)`);
  }
  // Print checksums so tts-manifest.json can be pinned from a real download.
  const unpinned = written.filter((w) => w.rel in manifest.files && !manifest.files[w.rel]);
  if (unpinned.length) {
    console.log('\nPin these into tools/tts-manifest.json:');
    for (const w of unpinned) console.log(`  "${w.rel}": "${w.sha256}",`);
  }
  console.log('Kokoro TTS model ready.');
}

module.exports = { MODEL_REPO, FILES, VOICES, ORT_FILES, ttsDir, isComplete };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
