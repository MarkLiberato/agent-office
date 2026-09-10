'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'office-agent-platform-'));
const handlers = new Map();
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    app: {
      getPath: () => userData,
      // A packaged app must still reject every updater action.
      isPackaged: true,
      getVersion: () => { throw new Error('Disabled updater must not inspect release versions'); }
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { openExternal: () => { throw new Error('Disabled updater must not open release links'); } }
  }
};
const { readConfig, writeConfig, resetConfig, modelForRole } = loadTs('src/main/config.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('fresh and reset installs require permission and opt-in background work', () => {
  for (const config of [readConfig(), resetConfig()]) {
    for (const flag of [
      'autoMode', 'orchestratorMaySpawn', 'semanticMemory', 'autoUpdate',
      'telemetryEnabled', 'freeflowEnabled', 'reflectEnabled', 'slackEnabled',
      'webhookEnabled', 'realtimeVoiceEnabled'
    ]) assert.equal(config[flag], false, flag);
    assert.deepEqual(config.missions, []);
    assert.equal(config.opsStandupSeeded, true, 'startup cannot seed hourly AI work');
    assert.equal(config.heartbeatSeeded, true, 'startup cannot seed heartbeat work');
    assert.equal(config.contextTrigger.compact.enabled, false);
    assert.equal(config.contextTrigger.clear.enabled, false);
    assert.equal(config.defaultCommand, 'codex');
    assert.equal(config.godProvider, 'codex');
    assert.equal(config.defaultModel, undefined);
    assert.equal(config.godModel, undefined);
  }
});

test('partial persisted context config remains opt-in; explicit choices survive reads', () => {
  writeConfig({ contextTrigger: { compact: { everyMs: 123_456 } } });
  assert.equal(readConfig().contextTrigger.compact.enabled, false);
  writeConfig({ contextTrigger: { compact: { enabled: true } } });
  assert.equal(readConfig().contextTrigger.compact.enabled, true);
  resetConfig();
});

test('Codex models use installed CLI default; explicit choices and other providers remain valid', () => {
  const config = readConfig();
  assert.equal(modelForRole({ isGod: true }, config), undefined);
  assert.equal(modelForRole({ role: 'verification' }, config), undefined);
  assert.equal(modelForRole({ isGod: true }, { ...config, godModel: 'chosen-model' }), 'chosen-model');
  assert.equal(modelForRole({ role: 'verification' }, config, 'claude'), 'claude-haiku-4-5-20251001');
  assert.equal(modelForRole({ role: 'developer' }, config, 'claude'), 'claude-sonnet-4-6');
  assert.equal(modelForRole({ isGod: true }, { godProvider: 'claude' }), 'claude-opus-4-8[1m]');
});

test('packaged updater rejects every manual action even when config says enabled', async () => {
  writeConfig({ autoUpdate: true });
  const { initAutoUpdater } = loadTs('src/main/updater.ts');
  initAutoUpdater(() => { throw new Error('Disabled updater must not emit release events'); });
  for (const name of [
    'update:restartAndInstall', 'update:checkNow', 'update:download',
    'update:simulate', 'update:openRelease'
  ]) {
    const result = await handlers.get(name)({}, 'https://github.com/chaitanyagiri/munder-difflin/releases/latest');
    assert.equal(result.ok, false, name);
    assert.match(result.error, /disabled/);
  }
  assert.deepEqual(handlers.get('update:current')(), { state: 'idle' });
  assert.equal(fs.existsSync(path.join(userData, 'last-run-version')), false);
});
