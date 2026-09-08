#!/usr/bin/env node
'use strict';

// Install with `npm ci --ignore-scripts`, then run this to avoid compiling
// SQLite against the host Node ABI before rebuilding it for Electron.
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run('node_modules/electron/install.js');
// node-pty 1.1 ships stable Node-API binaries; rebuilding these on Windows
// unnecessarily requires a full compiler with the extra Spectre libraries.
const ptyPrebuild = join(root, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`);
const hasPtyPrebuild = existsSync(join(ptyPrebuild, process.platform === 'win32' ? 'conpty.node' : 'pty.node'));
run('node_modules/@electron/rebuild/lib/cli.js', ['-f', '-o', hasPtyPrebuild ? 'better-sqlite3' : 'better-sqlite3,node-pty']);
run('tools/ensure-pty-perms.cjs');
run('tools/patch-node-pty-conpty.cjs');
// Kokoro TTS weights for the office floor voices. Fetched here so the app never
// downloads a model at run time (the synth worker sets allowRemoteModels=false).
run('tools/fetch-voices.cjs');
run('tools/check-native.cjs');
console.log('Office Agent native dependencies are ready.');
