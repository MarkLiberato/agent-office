'use strict';
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..');

// The floor voices are a runtime dependency like any native module: without the
// weights on disk the synth worker has nothing to load and every agent is mute.
const { isComplete } = require('./fetch-voices.cjs');
if (!isComplete()) {
  console.error('Kokoro TTS model missing. Run: node tools/fetch-voices.cjs');
  process.exit(1);
}

const result = spawnSync(require('electron'), [join(__dirname, 'native-smoke.cjs')], {
  cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8', timeout: 15000, windowsHide: true
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
