'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { OfficeSpeech } = loadTs('src/renderer/src/audio/officeSpeech.ts');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('caption starts only with real audio and cast speed/gain reach synthesis/playback', async () => {
  let resolveSynth;
  const synthResult = new Promise((resolve) => { resolveSynth = resolve; });
  const synthCalls = [];
  const provider = {
    synth(text, voice, speed) {
      synthCalls.push({ text, voice, speed });
      return synthResult;
    }
  };
  let playOptions = null;
  let resolveEnded;
  const mixer = {
    async playSpeech(_clip, opts) {
      playOptions = opts;
      return {
        durationMs: 720,
        ended: new Promise((resolve) => { resolveEnded = resolve; }),
        stop() { resolveEnded(); }
      };
    },
    async stopAllSpeech() {}
  };
  const timers = new Map();
  let timerId = 0;
  const clock = {
    now: () => 1000,
    setTimer(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
    random: () => 0.5
  };
  let captionDuration = null;
  const speech = new OfficeSpeech({ mixer, provider, clock });
  const id = speech.speak({
    agentId: 'agent-a', character: 'jim', text: 'I have a handoff for you.', pan: 0.35,
    onStart: (duration) => { captionDuration = duration; }
  });
  assert.ok(id);
  await flush();
  assert.equal(captionDuration, null, 'queued or synthesizing text is not yet a caption');

  resolveSynth({ pcm: new Float32Array(4), sampleRate: 24000 });
  await flush();
  assert.equal(captionDuration, 720);
  assert.equal(synthCalls[0].speed, 1, 'Jim keeps his stable cast speaking speed');
  assert.equal(playOptions.pan, 0.35);
  assert.equal(playOptions.gain, 0.92, 'Jim keeps his stable cast gain');
  resolveEnded();
  await flush();
});
