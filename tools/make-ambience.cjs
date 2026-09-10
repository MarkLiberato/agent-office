#!/usr/bin/env node
'use strict';

// Generate the office ambience clips.
//
// These are SYNTHESIZED rather than sampled, deliberately: a recorded office is
// somebody's copyrighted audio, and the sounds we want (a room bed, key clatter,
// a thunk, a distant ring) are all reachable with noise, an envelope and a
// filter. Nothing here is sourced from anyone, so there is no attribution to
// track and no licence to honour.
//
// Output is 16-bit mono WAV at 22.05 kHz into src/renderer/src/assets/audio,
// where Vite picks the files up as ordinary bundled assets. Re-run this to
// re-tune the office: the clips are build output, not hand-edited artefacts.
//
//   node tools/make-ambience.cjs

const fs = require('node:fs');
const path = require('node:path');

const RATE = 22050;
const OUT_DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'audio');

// ─── tiny DSP toolkit ────────────────────────────────────────────────────────

const noise = (n) => Float32Array.from({ length: n }, () => Math.random() * 2 - 1);

/** One-pole low-pass. `cut` is a corner frequency in Hz. */
function lowpass(buf, cut) {
  const dt = 1 / RATE;
  const rc = 1 / (2 * Math.PI * cut);
  const a = dt / (rc + dt);
  const out = new Float32Array(buf.length);
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    prev += a * (buf[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** One-pole high-pass. */
function highpass(buf, cut) {
  const dt = 1 / RATE;
  const rc = 1 / (2 * Math.PI * cut);
  const a = rc / (rc + dt);
  const out = new Float32Array(buf.length);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < buf.length; i++) {
    prevOut = a * (prevOut + buf[i] - prevIn);
    prevIn = buf[i];
    out[i] = prevOut;
  }
  return out;
}

const bandpass = (buf, lo, hi) => highpass(lowpass(buf, hi), lo);

/** Multiply by a per-sample envelope function of normalised time (0..1). */
function envelope(buf, fn) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] * fn(i / buf.length, i);
  return out;
}

/** Exponential decay, `tau` in seconds. */
const decay = (tau) => (_t, i) => Math.exp(-(i / RATE) / tau);

function mix(...bufs) {
  const len = Math.max(...bufs.map((b) => b.length));
  const out = new Float32Array(len);
  for (const b of bufs) for (let i = 0; i < b.length; i++) out[i] += b[i];
  return out;
}

function gain(buf, g) {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] * g;
  return out;
}

/** Scale so the loudest sample sits at `peak`. Keeps clips level with each other. */
function normalize(buf, peak = 0.8) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  return max === 0 ? buf : gain(buf, peak / max);
}

/** Crossfade the tail over the head so the clip loops without a seam. */
function seamless(buf, fadeSeconds) {
  const fade = Math.min(Math.floor(fadeSeconds * RATE), Math.floor(buf.length / 2));
  const out = buf.slice(0, buf.length - fade);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = buf[i] * t + buf[buf.length - fade + i] * (1 - t);
  }
  return out;
}

const seconds = (s) => Math.floor(s * RATE);

const sine = (freq, n, phase = 0) =>
  Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * freq * (i / RATE) + phase));

function silence(n) {
  return new Float32Array(n);
}

function concat(...bufs) {
  const total = bufs.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const b of bufs) { out.set(b, at); at += b.length; }
  return out;
}

function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // PCM chunk size
  header.writeUInt16LE(1, 20);            // format: PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);     // byte rate
  header.writeUInt16LE(2, 32);            // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return 44 + data.length;
}

// ─── the clips ───────────────────────────────────────────────────────────────

/** The bed: HVAC rumble, a mains-ish hum, and a wash of distant activity. */
function roomTone() {
  const n = seconds(12);
  const rumble = gain(lowpass(noise(n), 120), 1.0);
  const hum = gain(mix(sine(58, n), gain(sine(116, n), 0.3)), 0.02);
  const air = gain(bandpass(noise(n), 300, 2000), 0.09);
  // A slow swell so the bed breathes instead of sitting perfectly flat.
  const swell = envelope(air, (t) => 0.75 + 0.25 * Math.sin(2 * Math.PI * t * 2));
  return seamless(normalize(mix(rumble, hum, swell), 0.35), 1.0);
}

/** A burst of typing: irregular clicks, each a filtered transient. */
function keyboard(keys, seed) {
  let rnd = seed;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd / 2147483648;
  };
  const parts = [];
  for (let k = 0; k < keys; k++) {
    const click = envelope(bandpass(noise(seconds(0.05)), 1800, 7000), decay(0.008));
    // A touch of body so it reads as a key, not a spark.
    const body = envelope(bandpass(noise(seconds(0.05)), 300, 900), decay(0.012));
    parts.push(normalize(mix(click, gain(body, 0.5)), 0.5 + rand() * 0.4));
    parts.push(silence(seconds(0.05 + rand() * 0.12)));
  }
  return normalize(concat(...parts), 0.7);
}

/** Two rings of a phone somewhere else in the building. */
function phoneDistant() {
  const ringLen = seconds(0.9);
  const tone = mix(sine(480, ringLen), sine(620, ringLen));
  // 20 Hz warble is what makes a ring sound like a ring.
  const warbled = envelope(tone, (t) => (Math.sin(2 * Math.PI * 20 * t * 0.9) > 0 ? 1 : 0.25));
  // Heavy low-pass plus low level = "through a wall".
  const ring = gain(lowpass(warbled, 1100), 0.25);
  const shaped = envelope(ring, (t) => Math.min(1, t * 20) * Math.min(1, (1 - t) * 20));
  return normalize(concat(shaped, silence(seconds(0.7)), shaped), 0.45);
}

/** Grinder, then the hiss and gurgle of the pour. */
function coffeeMachine() {
  const grindN = seconds(0.9);
  const grind = envelope(bandpass(noise(grindN), 200, 3000), (t) =>
    Math.min(1, t * 12) * Math.min(1, (1 - t) * 8) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 38 * t * 0.9))
  );
  const pourN = seconds(1.4);
  const hiss = gain(bandpass(noise(pourN), 1200, 6000), 0.5);
  const gurgle = envelope(lowpass(noise(pourN), 400), (t) => 0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * t * 1.4));
  const pour = envelope(mix(hiss, gurgle), (t) => Math.min(1, t * 8) * Math.min(1, (1 - t) * 4));
  return normalize(concat(normalize(grind, 0.6), silence(seconds(0.1)), normalize(pour, 0.5)), 0.75);
}

/** The can hitting the tray. */
function vendingThunk() {
  const n = seconds(0.45);
  const thud = envelope(mix(sine(72, n), gain(sine(110, n), 0.4)), decay(0.09));
  const impact = envelope(bandpass(noise(n), 150, 2500), decay(0.02));
  const rattle = envelope(bandpass(noise(seconds(0.25)), 900, 5000), decay(0.05));
  return normalize(mix(thud, gain(impact, 0.7), gain(concat(silence(seconds(0.06)), rattle), 0.25)), 0.85);
}

/** Someone shifting their weight — narrow band noise with a slow pitch drift. */
function chairCreak() {
  const n = seconds(0.7);
  const raw = noise(n);
  const out = new Float32Array(n);
  // A sweeping resonant peak, done as a state-variable-ish two-pole.
  let lp = 0;
  let bp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = 380 + 420 * Math.sin(Math.PI * t);       // sweep up and back
    const q = 0.06;
    const g2 = 2 * Math.sin((Math.PI * f) / RATE);
    const hp = raw[i] - lp - q * bp;
    bp += g2 * hp;
    lp += g2 * bp;
    out[i] = bp;
  }
  const shaped = envelope(out, (t) => Math.min(1, t * 6) * Math.pow(1 - t, 1.5));
  return normalize(shaped, 0.5);
}

/** Feed rollers plus the carriage stepping across. */
function printer() {
  const n = seconds(1.6);
  const motor = envelope(bandpass(noise(n), 250, 1800), (t) =>
    Math.min(1, t * 10) * Math.min(1, (1 - t) * 10) * (0.65 + 0.35 * Math.sin(2 * Math.PI * 26 * t * 1.6))
  );
  const steps = [];
  for (let i = 0; i < 7; i++) {
    steps.push(silence(seconds(0.18)));
    steps.push(envelope(bandpass(noise(seconds(0.04)), 900, 4500), decay(0.01)));
  }
  return normalize(mix(gain(motor, 0.8), gain(concat(...steps), 0.5)), 0.6);
}

// ─── main ────────────────────────────────────────────────────────────────────

const CLIPS = {
  'room-tone.wav': roomTone,
  'keyboard-1.wav': () => keyboard(7, 12345),
  'keyboard-2.wav': () => keyboard(5, 98765),
  'phone-distant.wav': phoneDistant,
  'coffee-machine.wav': coffeeMachine,
  'vending-thunk.wav': vendingThunk,
  'chair-creak.wav': chairCreak,
  'printer.wav': printer
};

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  for (const [name, make] of Object.entries(CLIPS)) {
    const bytes = writeWav(path.join(OUT_DIR, name), make());
    total += bytes;
    console.log(`  ${name} (${(bytes / 1024).toFixed(0)} KB)`);
  }
  console.log(`Office ambience written to src/renderer/src/assets/audio (${(total / 1024).toFixed(0)} KB total).`);
}

module.exports = { CLIPS: Object.keys(CLIPS), OUT_DIR };

if (require.main === module) main();
