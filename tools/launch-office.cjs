#!/usr/bin/env node
'use strict';
const { existsSync, openSync, closeSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const root = resolve(__dirname, '..');
if (!existsSync(join(root, 'out/main/index.js'))) {
  console.error('Office Agent needs its first build. Run Setup Office Agent.cmd.');
  process.exit(1);
}
let electron;
try { electron = require('electron'); }
catch { console.error('Office Agent dependencies are missing. Run Setup Office Agent.cmd.'); process.exit(1); }
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const logPath = join(root, 'office-agent-startup.log');
const log = openSync(logPath, 'a');
const child = spawn(electron, [root], { cwd: root, env, detached: true, stdio: ['ignore', log, log], windowsHide: true });
closeSync(log);
let startup = true;
const timer = setTimeout(() => { startup = false; child.unref(); }, 2000);
child.on('error', (error) => {
  clearTimeout(timer);
  console.error(`Could not open Office Agent: ${error.message}\nDetails: ${logPath}`);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  if (!startup) return;
  clearTimeout(timer);
  if (code !== 0) {
    console.error(`Office Agent exited during startup (${code}). Details: ${logPath}`);
    process.exitCode = 1;
  }
});
