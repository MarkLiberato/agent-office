'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { Mixer, dbToGain } = loadTs('src/renderer/src/audio/mixer.ts');

/** Minimal Web Audio stand-in. Records every node it makes so the graph can be
 *  asserted without a browser. Sources only end when the test says so, which is
 *  exactly the contract the director depends on. */
function fakeContext() {
  const gains = [];
  const panners = [];
  const sources = [];
  const mkParam = (value) => ({
    value,
    cancelScheduledValues() {},
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; }
  });
  const mkNode = (extra) => Object.assign({ connect() {}, disconnect() {} }, extra);
  return {
    currentTime: 0,
    state: 'running',
    gains, panners, sources,
    destination: mkNode({}),
    async resume() { this.state = 'running'; },
    createGain() { const n = mkNode({ gain: mkParam(1) }); gains.push(n); return n; },
    createStereoPanner() { const n = mkNode({ pan: mkParam(0) }); panners.push(n); return n; },
    createDynamicsCompressor() {
      return mkNode({
        threshold: mkParam(0), knee: mkParam(0), ratio: mkParam(1),
        attack: mkParam(0), release: mkParam(0)
      });
    },
    createBuffer(_ch, length, sampleRate) {
      return {
        duration: length / sampleRate, length, sampleRate,
        getChannelData: () => new Float32Array(length)
      };
    },
    createBufferSource() {
      const s = mkNode({
        buffer: null, onended: null, started: false, stoppedAt: null,
        start() { this.started = true; },
        stop(when) { this.stoppedAt = when === undefined ? 0 : when; },
        fireEnded() { if (this.onended) this.onended(); }
      });
      sources.push(s);
      return s;
    }
  };
}

const clip = (seconds) => ({ pcm: new Float32Array(24000 * seconds), sampleRate: 24000 });

test('dbToGain converts the overlap trim', () => {
  assert.ok(Math.abs(dbToGain(-12) - 0.2512) < 0.001);
  assert.equal(dbToGain(0), 1);
});

test('a played line reports its duration and ends only when the source ends', async () => {
  const ctx = fakeContext();
  const mixer = new Mixer(ctx);
  const play = await mixer.playSpeech(clip(1.5));
  assert.equal(play.durationMs, 1500);
  assert.equal(mixer.activeSpeechCount, 1);

  let ended = false;
  void play.ended.then(() => { ended = true; });
  await Promise.resolve();
  assert.equal(ended, false, 'audio has not finished yet');

  ctx.sources[0].fireEnded();
  await play.ended;
  assert.equal(mixer.activeSpeechCount, 0);
});

test('per-line gain and pan land on this line only', async () => {
  const ctx = fakeContext();
  const mixer = new Mixer(ctx);
  await mixer.playSpeech(clip(1), { gain: dbToGain(-12), pan: -0.6 });
  const lineGain = ctx.gains[ctx.gains.length - 1];
  assert.ok(Math.abs(lineGain.gain.value - 0.2512) < 0.001);
  assert.equal(ctx.panners[0].pan.value, -0.6);
});

test('two overlapping lines duck the room once and release once', async () => {
  const ctx = fakeContext();
  const mixer = new Mixer(ctx);
  mixer.setAmbienceVolume(0.6);
  const amb = mixer.ambienceBus;

  const a = await mixer.playSpeech(clip(1));
  const duckedTo = amb.gain.value;
  assert.ok(duckedTo < 0.6, 'the first line ducks the room');

  const b = await mixer.playSpeech(clip(1));
  assert.equal(amb.gain.value, duckedTo, 'the second line must not re-ramp');

  ctx.sources[0].fireEnded();
  await a.ended;
  assert.equal(amb.gain.value, duckedTo, 'a line is still speaking, stay ducked');

  ctx.sources[1].fireEnded();
  await b.ended;
  assert.equal(amb.gain.value, 0.6, 'the room comes back when the floor is quiet');
});

test('stopAllSpeech fades every line and resolves once they are silent', async () => {
  const ctx = fakeContext();
  const mixer = new Mixer(ctx);
  await mixer.playSpeech(clip(5));
  await mixer.playSpeech(clip(5));

  const silence = mixer.stopAllSpeech(100);
  assert.equal(ctx.sources[0].stoppedAt, 0.1, 'stop is scheduled at the fade end');
  ctx.sources.forEach((s) => s.fireEnded());
  await silence;
  assert.equal(mixer.activeSpeechCount, 0);
});
