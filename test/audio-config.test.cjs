'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('all three HarnessConfig mirrors declare the audio block', () => {
  assert.match(read('src/main/config.ts'), /audio\?:\s*AudioSettings/);
  assert.match(read('src/renderer/src/store/config.ts'), /audio\?:\s*AudioSettings/);
  // The preload bridge is a third mirror; without it updateConfig({ audio })
  // does not typecheck and the setting cannot cross the bridge at all.
  assert.match(read('src/preload/index.ts'), /audio\?:\s*AudioSettings/);
});

test('the main defaults carry the agreed values', () => {
  const main = read('src/main/config.ts');
  assert.match(main, /master:\s*0\.5/);
  assert.match(main, /speech:\s*true/);
  assert.match(main, /ambience:\s*true/);
  assert.match(main, /ambienceVolume:\s*0\.6/);
});

test('every audio string exists in all three locales', () => {
  const keys = [
    'settings.audio.title',
    'settings.audio.master',
    'settings.audio.speech',
    'settings.audio.speechVolume',
    'settings.audio.ambience',
    'settings.audio.ambienceVolume'
  ];
  for (const locale of ['en', 'ar', 'zh-CN']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}.json`));
    for (const key of keys) {
      const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), json);
      assert.equal(typeof value, 'string', `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }
  }
});
