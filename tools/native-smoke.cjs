'use strict';
// Run with Electron in Node mode to verify the exact desktop ABI and ConPTY.
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const pty = require('node-pty');
const db = new Database(':memory:');
assert.equal(db.prepare('select 42 as value').get().value, 42);
db.close();
const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
const args = process.platform === 'win32' ? ['/d', '/c', 'echo OFFICE_AGENT_PTY_OK'] : ['-c', 'echo OFFICE_AGENT_PTY_OK'];
const term = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  ...(process.platform === 'win32' ? { useConptyDll: true } : {}) });
let output = '';
const timer = setTimeout(() => { term.kill(); console.error('PTY smoke timed out'); process.exit(1); }, 10000);
term.onData(data => { output += data; });
term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  assert.equal(exitCode, 0);
  assert.match(output, /OFFICE_AGENT_PTY_OK/);
  console.log(JSON.stringify({ electron: process.versions.electron, sqlite: 'passed', pty: 'passed' }));
  process.exit(0);
});
