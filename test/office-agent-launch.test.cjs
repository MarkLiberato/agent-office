'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { codexPermissionArgs, codexResumeArgs } = loadTs('src/shared/codexLaunch.ts');

function isolated(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office launch spaces '));
  const home = path.join(base, 'user home');
  const harness = path.join(base, 'office home');
  fs.mkdirSync(home, { recursive: true });
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'never provision hooks against the real user home');
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { hive: new HiveManager(() => harness), harness };
}

test('fresh and resumed Codex coordinator argv never carries an orientation prompt', async (t) => {
  const { hive, harness } = isolated(t);
  const meta = { id: 'god', name: 'Coordinator', isGod: true, provider: 'codex', cwd: harness };
  const fresh = await hive.ensureAgent(meta);
  assert.match(fresh.seedPrompt, /HIVE PROTOCOL/);
  const freshArgv = codexPermissionArgs(fresh.args, false);
  assert.ok(!freshArgv.some((arg) => arg.includes(fresh.seedPrompt)));
  assert.ok(!freshArgv.includes('resume'));
  hive.recordSession('god', 'session-test');
  const restored = await hive.ensureAgent(meta);
  const resumedArgv = codexPermissionArgs(codexResumeArgs(restored.args, hive.lastSession('god')), false);
  assert.ok(!resumedArgv.some((arg) => arg.includes(restored.seedPrompt)));
  assert.equal(resumedArgv[4], 'resume');
  assert.equal(resumedArgv[5], 'session-test');
  // Provisioning workers remains capable of launching their explicitly hired work.
  const worker = await hive.ensureAgent({ ...meta, id: 'worker', isGod: false });
  assert.ok(worker.args.some((arg) => arg.includes('HIVE PROTOCOL')));
});

test('coordinator deferral applies to flag and system-prompt providers', async (t) => {
  const { hive, harness } = isolated(t);
  for (const provider of ['claude', 'gemini']) {
    const injection = await hive.ensureAgent({ id: `god-${provider}`, name: 'Coordinator', isGod: true, provider, cwd: harness });
    assert.match(injection.seedPrompt, /HIVE PROTOCOL/);
    assert.ok(!injection.args.some((arg) => arg.includes('HIVE PROTOCOL')));
    assert.ok(!injection.args.includes('-i'));
    assert.ok(!injection.args.includes('--append-system-prompt'));
  }
});

test('manual Codex launch overrides inherited and command-authored permission bypasses', () => {
  const untrusted = [
    '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo',
    '-a', 'never', '--ask-for-approval=never', '-s', 'danger-full-access',
    '--sandbox=danger-full-access', '-anever', '-sdanger-full-access',
    '-c', 'approval_policy="never"', '--config=sandbox_mode="danger-full-access"',
    '--model', 'chosen-model', '--add-dir', 'C:\\Office data', '-c', 'model_reasoning_effort="high"'
  ];
  assert.deepEqual(codexPermissionArgs(untrusted, false), [
    '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request',
    '--model', 'chosen-model', '--add-dir', 'C:\\Office data', '-c', 'model_reasoning_effort="high"'
  ]);
  assert.deepEqual(codexPermissionArgs(untrusted, true), untrusted, 'explicit automatic mode preserved');
  assert.deepEqual(codexPermissionArgs(['--', '--sandbox=prompt text'], false).slice(4), ['--', '--sandbox=prompt text']);
});

test('Windows generated Codex hook executes from a hive path containing spaces', { skip: process.platform !== 'win32' }, async (t) => {
  const { hive, harness } = isolated(t);
  const injection = await hive.ensureAgent({ id: 'god', name: 'Coordinator', provider: 'codex', isGod: true, cwd: harness });
  const config = fs.readFileSync(path.join(injection.env.CODEX_HOME, 'config.toml'), 'utf8');
  const command = JSON.parse(config.match(/^command = (".*")$/m)[1]);
  const shim = path.join(harness, 'hive', 'bin', 'cth-hook.cjs');
  fs.writeFileSync(shim, 'process.stdin.resume(); let text=""; process.stdin.on("data", d => text += d); process.stdin.on("end", () => process.stdout.write(JSON.stringify({received:JSON.parse(text),file:__filename})));');
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('error', reject);
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Hook command timed out')); }, 10000);
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart' }));
  });
  assert.equal(outcome.code, 0, outcome.stderr);
  const payload = JSON.parse(outcome.stdout);
  assert.equal(payload.file, shim);
  assert.equal(payload.received.hook_event_name, 'SessionStart');
});
