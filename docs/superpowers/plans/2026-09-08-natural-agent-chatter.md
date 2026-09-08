# Natural Agent Chatter and Responsive Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stalled global speech queue with a self-waking, audio-synchronized
speech director so office agents hold balanced, original, turn-based conversations and
react safely to work events without ever bleeding into an open microphone.

**Architecture:** A new `speechDirector.ts` owns scheduling (turn order, gaps, priorities,
cooldowns, expiry, bounds, cancellation, rare quiet overlap) behind an injected clock,
timer, RNG and `SpeechSink`, so all of it is testable with no real audio. `mixer.ts` grows
per-line playback handles (`ended` / `stop()`), ref-counted overlap-safe ducking, a limiter,
and per-line gain and pan. `index.ts` wires the director to the Kokoro provider and mixer,
synthesizing the next turn while the current one plays. The scene stops speaking from
`showThought()` and instead raises explicit spoken intents; captions appear on real
playback start and are restored to the work-status bubble on end.

**Tech Stack:** TypeScript (strict), Electron + Vite, Pixi.js scene, Web Audio API,
kokoro-js in a Web Worker, `node --test` with `test/load-ts.cjs` for the pure modules.

**Spec:** `docs/superpowers/specs/2026-09-08-natural-agent-chatter.md`
(builds on `docs/superpowers/specs/2026-09-08-office-agent-voice-design.md`)

## Global Constraints

- **No new runtime dependencies.** Everything here is standard library, Web Audio, or
  already in `package.json`.
- **Offline forever.** Nothing added may fetch at runtime. Kokoro stays served from the
  `office-tts://model` protocol.
- **Pure modules stay DOM-free at import time** so `test/load-ts.cjs` can load them under
  `node --test`. Web Audio and Worker plumbing live in thin shells around them.
- **Tests run with `npm run test:focused`** (`node --test test/*.test.cjs`). Typecheck with
  `npm run typecheck` (both `typecheck:node` and `typecheck:web`).
- **Injected clock everywhere.** No pure module calls `Date.now()`, `performance.now()`,
  `Math.random()` or `setTimeout` directly; all four arrive through a `DirectorClock`.
- **Bounds are exact:** 16 pending utterances globally, 6 per conversation, PCM cache 200
  entries **and** 64 MiB, reply gap 200-450 ms, overlap window 250 ms, overlap gain -12 dB,
  max 2 simultaneous voices, reaction cooldown 12000 ms, per-agent floor 6000 ms, social
  cadence 20000-40000 ms, synthesis timeout 15000 ms, mic fade-stop 100 ms.
- **Privacy is a hard rule.** Only text produced by `cafeteriaLines.ts` and
  `reactionLines.ts` may reach the synthesizer. Prompts, task text, message subjects and
  bodies, terminal output, filenames, paths, memory and webhook/Slack content must not.
- **No persisted-state changes.** No config migration, no IPC schema change, no new
  settings key. `AudioConfig` in `src/renderer/src/audio/index.ts` keeps its five fields.
- **Content rules for every new line:** original writing only — no recognizable quotations
  from *The Office* or any other show. Playful adult humor is allowed. Excluded: slurs,
  jokes keyed to protected traits, targeted gossip about a named coworker, explicit sexual
  material, and any claim to be a real person.
- **Preserve the uncommitted workspace.** The tree already carries unstaged work; never
  `git checkout`/`git stash`/`git reset` across it. Commit only the files each task names.
- **Windows shell.** Commands below are written for the repo's PowerShell/Git-Bash setup;
  `npm` scripts are the portable path.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/renderer/src/audio/speechIntent.ts` | The `SpokenIntent` type, priority ranking, and the `isSpeakable()` privacy guard. Pure. |
| `src/renderer/src/audio/speechDirector.ts` | Self-waking scheduler: turn order, gaps, priorities, cooldowns, expiry, bounds, cancellation, quiet overlap. Pure, injected clock/timer/RNG/sink. |
| `src/renderer/src/audio/reactionLines.ts` | Original one-liners for work events, generated from act + role + coarse status only. Pure. |
| `src/renderer/src/audio/chatterCadence.ts` | When to start a social exchange (20-40 s) and the 12 s reaction cooldown. Pure. |
| `test/tts-speech-intent.test.cjs` | Intent shape + privacy guard. |
| `test/tts-speech-director.test.cjs` | Wake-up, ordering, reply timing, prepare-ahead. |
| `test/tts-director-policy.test.cjs` | Priorities, cooldowns, expiry, bounds, cancellation, overlap. |
| `test/tts-mixer.test.cjs` | Handles, ducking, limiter, pan/gain, stop-all. |
| `test/tts-engine-recovery.test.cjs` | Synthesis timeout, one worker restart, session disable. |
| `test/tts-office-audio.test.cjs` | Wiring: caption-on-start, prepare-ahead, mic silence. |
| `test/chatter-lines.test.cjs` | Original-material canary + line shape. |
| `test/reaction-lines.test.cjs` | Privacy canary for work-event reactions. |
| `test/mic-silence.test.cjs` | Both mic call sites await silence before `getUserMedia`. |

**Modified**

| File | Change |
|---|---|
| `src/renderer/src/audio/mixer.ts` | Per-line playback handle, ref-counted ducking, limiter, pan + gain, `stopAllSpeech()`, injectable context. |
| `src/renderer/src/audio/ttsCache.ts` | Byte budget alongside the entry cap. |
| `src/renderer/src/audio/ttsEngine.ts` | 15 s synthesis timeout, one worker restart, permanent session disable after a repeat failure. |
| `src/renderer/src/audio/index.ts` | Director wiring, prepare-ahead sink, `silenceForMic()` / `resumeAfterMic()`, injectable deps. |
| `src/renderer/src/audio/ambience.ts` | `fadeStop()` for the 100 ms mic hand-off. |
| `src/renderer/src/scene/office/cafeteriaLines.ts` | Rewritten as original banter. |
| `src/renderer/src/scene/office/Character.ts` | `showThought()` visual-only; new `say()` with caption-on-start / restore-on-end. |
| `src/renderer/src/scene/office/OfficeFloor.tsx` | Conversations driven by director callbacks; work-event reactions; cancellation on leave/resume/despawn/unmount. |
| `src/renderer/src/realtime/session.ts` | Await `silenceForMic()` before `getUserMedia`; `resumeAfterMic()` on teardown. |
| `src/renderer/src/freeflow/recorder.ts` | Same, for push-to-talk dictation. |

**Deleted**

| File | Reason |
|---|---|
| `src/renderer/src/audio/speechQueue.ts` | Superseded by `speechDirector.ts` (Task 6 removes it). |
| `test/tts-speech-queue.test.cjs` | Tests the deleted module (Task 6 removes it). |

---
### Task 1: Mixer playback handles, ref-counted ducking, limiter, pan

The director cannot time anything until playback tells it when a line really ended, and it
cannot overlap two lines until ducking stops fighting itself. This task makes the audio
graph answer both.

**Files:**
- Modify: `src/renderer/src/audio/mixer.ts` (whole file rewritten)
- Modify: `src/renderer/src/audio/index.ts:118` (one call site, so it still typechecks)
- Test: `test/tts-mixer.test.cjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `dbToGain(db: number): number`
  - `interface SpeechPlayback { readonly durationMs: number; readonly ended: Promise<void>; stop(fadeMs?: number): void }`
  - `interface PlayOptions { gain?: number; pan?: number }`
  - `class Mixer` with `constructor(context?: AudioContext)`,
    `playSpeech(result: { pcm: Float32Array; sampleRate: number }, opts?: PlayOptions): Promise<SpeechPlayback>`,
    `stopAllSpeech(fadeMs?: number): Promise<void>`, `get activeSpeechCount(): number`,
    and the existing `resume()`, `setMaster()`, `setSpeechVolume()`, `setAmbienceVolume()`,
    `get ambienceBus()`, `get context()`.

- [ ] **Step 1: Write the failing test**

Create `test/tts-mixer.test.cjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/tts-mixer.test.cjs`
Expected: FAIL — `dbToGain is not a function`, and `new Mixer(ctx)` ignores the injected
context because the current constructor calls `new AudioContext()`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/renderer/src/audio/mixer.ts` with:

```ts
// The Web Audio graph.
//
//   line -> lineGain -> panner --+
//                                +--> speechGain --+
//   ambience -----------> ambGain -----------------+--> master -> limiter -> out
//
// Two things changed when conversations arrived. Every spoken line now owns a
// gain and a panner, so a background remark can sit 12 dB under the foreground
// line and off to one side. And ducking is REF-COUNTED: with two lines running,
// the first one to finish must not schedule the release ramp and lift the room
// back up underneath the one still talking.

const DUCK_FACTOR = 0.33;
const DUCK_ATTACK_S = 0.08;
const DUCK_RELEASE_S = 0.4;
/** Fade used when a line is cut short (mic hand-off, cancellation). */
const DEFAULT_FADE_MS = 80;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Decibel trim to linear gain. The overlap rule is written in dB; Web Audio is not. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export interface SpeechPlayback {
  /** Clip length in ms. The caption holds for exactly this long. */
  readonly durationMs: number;
  /** Resolves when the audio really finished, or was stopped. Authoritative —
   *  the director times every turn off this, never off a visual beat. */
  readonly ended: Promise<void>;
  /** Cut the line short with a short fade. Idempotent. */
  stop(fadeMs?: number): void;
}

export interface PlayOptions {
  /** Linear gain for this line alone, 0..1. Default 1. */
  gain?: number;
  /** Stereo position, -1 (hard left) .. 1 (hard right). Default 0. */
  pan?: number;
}

export class Mixer {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly speechGain: GainNode;
  private readonly ambGain: GainNode;
  private ambienceLevel = 0.6;
  /** How many lines are currently ducking the room. */
  private duckDepth = 0;
  private readonly active = new Set<SpeechPlayback>();

  /** The context is injectable so the graph can be asserted under `node --test`;
   *  the app always takes the default. */
  constructor(context: AudioContext = new AudioContext()) {
    this.context = context;
    this.master = context.createGain();
    this.speechGain = context.createGain();
    this.ambGain = context.createGain();
    this.master.gain.value = 0.5;
    this.speechGain.gain.value = 1;
    this.ambGain.gain.value = this.ambienceLevel;

    // A limiter on the sum, not on speech alone: two voices plus a ducked room
    // can still clip, and a clipped quip sounds broken rather than loud.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    this.speechGain.connect(this.master);
    this.ambGain.connect(this.master);
    this.master.connect(limiter);
    limiter.connect(context.destination);
  }

  /** Browsers start the context suspended until a gesture; call on first click. */
  async resume(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
  }

  setMaster(v: number): void {
    this.master.gain.value = clamp(v, 0, 1);
  }

  setSpeechVolume(v: number): void {
    this.speechGain.gain.value = clamp(v, 0, 1);
  }

  setAmbienceVolume(v: number): void {
    this.ambienceLevel = clamp(v, 0, 1);
    // Respect an in-progress duck: a volume change mid-line must not undo it.
    this.ambGain.gain.value = this.duckDepth > 0
      ? this.ambienceLevel * DUCK_FACTOR
      : this.ambienceLevel;
  }

  get ambienceBus(): GainNode {
    return this.ambGain;
  }

  get activeSpeechCount(): number {
    return this.active.size;
  }

  /** Play one synthesized line. Resolves once it has STARTED, with a handle whose
   *  `ended` resolves when the audio is actually over. */
  async playSpeech(
    result: { pcm: Float32Array; sampleRate: number },
    opts: PlayOptions = {}
  ): Promise<SpeechPlayback> {
    await this.resume();
    const buffer = this.context.createBuffer(1, result.pcm.length, result.sampleRate);
    // copyToChannel is typed for a plain ArrayBuffer, while PCM arriving from a
    // worker is Float32Array<ArrayBufferLike>. Write the channel directly rather
    // than casting the buffer's provenance away.
    buffer.getChannelData(0).set(result.pcm);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const lineGain = this.context.createGain();
    lineGain.gain.value = clamp(opts.gain ?? 1, 0, 1);
    const panner = this.context.createStereoPanner();
    panner.pan.value = clamp(opts.pan ?? 0, -1, 1);
    source.connect(lineGain);
    lineGain.connect(panner);
    panner.connect(this.speechGain);

    let settle!: () => void;
    const ended = new Promise<void>((resolve) => { settle = resolve; });
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      this.active.delete(handle);
      this.duckRelease();
      settle();
    };

    const handle: SpeechPlayback = {
      durationMs: buffer.duration * 1000,
      ended,
      stop: (fadeMs = DEFAULT_FADE_MS) => {
        if (done) return;
        const t = this.context.currentTime;
        const g = lineGain.gain;
        const fade = Math.max(0, fadeMs) / 1000;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + fade);
        try {
          source.stop(t + fade);
        } catch {
          // Already stopped by the engine — onended has fired or is about to.
          finish();
        }
      }
    };

    source.onended = finish;

    this.duckAcquire();
    this.active.add(handle);
    source.start();
    return handle;
  }

  /** Silence the floor within `fadeMs` and resolve once every line is really
   *  over. The mic hand-off awaits this before opening capture. */
  async stopAllSpeech(fadeMs = 100): Promise<void> {
    const handles = [...this.active];
    for (const h of handles) h.stop(fadeMs);
    await Promise.all(handles.map((h) => h.ended));
  }

  private duckAcquire(): void {
    this.duckDepth++;
    if (this.duckDepth > 1) return;      // already ducked; do not re-ramp
    const t = this.context.currentTime;
    const g = this.ambGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.ambienceLevel * DUCK_FACTOR, t + DUCK_ATTACK_S);
  }

  private duckRelease(): void {
    this.duckDepth = Math.max(0, this.duckDepth - 1);
    if (this.duckDepth > 0) return;      // someone is still talking
    const t = this.context.currentTime;
    const g = this.ambGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.ambienceLevel, t + DUCK_RELEASE_S);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/tts-mixer.test.cjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Keep the existing caller compiling**

`src/renderer/src/audio/index.ts` line 118 reads `const ms = await this.mixer.playSpeech(result);`
and now receives a `SpeechPlayback`. Task 6 replaces this method entirely; for now make the
two lines read:

```ts
          const play = await this.mixer.playSpeech(result);
          const ms = play.durationMs;
```

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `npm run typecheck:web`
Expected: PASS.

Run: `npm run test:focused`
Expected: PASS. `test/tts-speech-queue.test.cjs` still passes — nothing is removed yet.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/audio/mixer.ts src/renderer/src/audio/index.ts test/tts-mixer.test.cjs
git commit -m "feat(audio): per-line playback handles, ref-counted ducking, limiter, pan"
```

---

### Task 2: Spoken intents and the privacy guard

Every line the floor speaks must be an explicit intent carrying its own identity and
lifetime, and its text must be provably free of work data. This is the vocabulary the rest
of the plan is written in.

**Files:**
- Create: `src/renderer/src/audio/speechIntent.ts`
- Test: `test/tts-speech-intent.test.cjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SpeechPriority = 'conversation' | 'reaction' | 'ambient'`
  - `PRIORITY_RANK: Record<SpeechPriority, number>` (lower number wins)
  - `interface SpokenIntent` — fields listed in the implementation below
  - `isSpeakable(text: string): boolean`
  - `MAX_SPOKEN_CHARS = 90`

- [ ] **Step 1: Write the failing test**

Create `test/tts-speech-intent.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { isSpeakable, PRIORITY_RANK, MAX_SPOKEN_CHARS } =
  loadTs('src/renderer/src/audio/speechIntent.ts');

test('ordinary banter is speakable', () => {
  assert.equal(isSpeakable('is this decaf? who did this'), true);
  assert.equal(isSpeakable('big day. lots of meetings.'), true);
});

test('empty and overlong text is refused', () => {
  assert.equal(isSpeakable(''), false);
  assert.equal(isSpeakable('   '), false);
  assert.equal(isSpeakable('x'.repeat(MAX_SPOKEN_CHARS + 1)), false);
});

// The guard is the last line of defence, not the first: nothing should ever hand
// it work data. These are the shapes that would mean a leak happened upstream.
test('work data never passes the guard', () => {
  const leaks = [
    'edit src/renderer/src/App.tsx',
    'bash npm test',
    'C:\\Users\\AnjMark\\Documents\\Projects\\office-agent',
    'https://hooks.slack.com/services/T000/B000/xyz',
    'read ~/.claude/settings.json',
    'error: ENOENT no such file or directory',
    'sk-ant-api03-abcdefghijklmnop',
    'subject: Q3 revenue plan',
    'commit 3e4f9f6 merged into main',
    '<@U0123ABC> can you look at this',
    'const x = await fetch(url)'
  ];
  for (const leak of leaks) {
    assert.equal(isSpeakable(leak), false, `must not speak: ${leak}`);
  }
});

test('conversation beats outrank reactions, which outrank ambient chatter', () => {
  assert.ok(PRIORITY_RANK.conversation < PRIORITY_RANK.reaction);
  assert.ok(PRIORITY_RANK.reaction < PRIORITY_RANK.ambient);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/tts-speech-intent.test.cjs`
Expected: FAIL — `Cannot find module .../speechIntent.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/audio/speechIntent.ts`:

```ts
// What the floor is allowed to say, and how one line is identified.
//
// A thought bubble is a picture; a SpokenIntent is a commitment to make noise.
// Keeping them separate is what stops live work status ("edit App.tsx") from
// being read aloud — the scene has to ASK for speech, with a line drawn from a
// fixed pool, and every intent carries its own lifetime so a line whose moment
// has passed is dropped rather than spoken late.

export type SpeechPriority = 'conversation' | 'reaction' | 'ambient';

/** Lower wins. A conversation beat must never be pre-empted by small talk. */
export const PRIORITY_RANK: Record<SpeechPriority, number> = {
  conversation: 0,
  reaction: 1,
  ambient: 2
};

export interface SpokenIntent {
  /** Unique per utterance. Two agents may say identical words at once and each
   *  must still be cancellable and captioned on its own. */
  utteranceId: string;
  agentId: string;
  voiceId: string;
  /** Already substituted and already checked by isSpeakable(). */
  text: string;
  priority: SpeechPriority;
  /** Set on both beats of a dialogue so turn order and cancellation are cheap. */
  conversationId?: string;
  /** 0-based position within `conversationId`. Beats play in order. */
  beatIndex?: number;
  /** Not before this time. Reply gaps are expressed by moving this forward. */
  eligibleAt: number;
  /** Dropped unspoken after this time — its moment has gone. */
  expiresAt: number;
  /** Stereo position of the speaker, -1..1, from the avatar's screen x. */
  pan: number;
  /** Fired when audio actually STARTS, with the clip length. Captions hang off this. */
  onStart?: (durationMs: number) => void;
  /** Fired when audio ends, is stopped, or the intent is dropped unspoken. */
  onEnd?: () => void;
}

/** Longest line the floor will speak. Longer than the thought cloud can show and
 *  longer than anyone wants to listen to between two sprites. */
export const MAX_SPOKEN_CHARS = 90;

// Shapes that mean work data reached the synthesizer. This is a backstop for the
// real rule (speech text comes only from cafeteriaLines.ts and reactionLines.ts),
// so it is deliberately blunt: banter has no reason to contain a path, a URL, a
// key, a mail header or a code fragment.
const FORBIDDEN = [
  /[/\\][\w.-]+[/\\]/,             // a path with at least two separators
  /\.(ts|tsx|js|jsx|json|md|py|rs|go|cjs|mjs|yml|yaml|toml|log|env)\b/i,
  /https?:\/\//i,
  /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,
  /~[/\\]/,
  /\bsk-[a-z0-9-]{8,}/i,
  /\b(subject|from|to|cc|bcc)\s*:/i,
  /\b(error|warn|enoent|eacces|traceback|exception)\b/i,
  /\bcommit\s+[0-9a-f]{6,}\b/i,
  /<[@#!][\w-]+>/,                 // Slack mention / channel tokens
  /[<>{}]|=>|\$\{|`/,              // markup, code and template fragments
  /\b(const|let|var|function|await|async|import|export|return)\b/,
  /\b[0-9a-f]{12,}\b/i             // hashes and ids
];

/** True when this text may be handed to the synthesizer. */
export function isSpeakable(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_SPOKEN_CHARS) return false;
  return !FORBIDDEN.some((re) => re.test(trimmed));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/tts-speech-intent.test.cjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/audio/speechIntent.ts test/tts-speech-intent.test.cjs
git commit -m "feat(audio): spoken intents with an explicit privacy guard"
```

---
### Task 3: The self-waking speech director — turn order and reply timing

This is the fix for the stall. `SpeechQueue` only ever moved when someone called `speak()`;
the director owns a timer, so an expired gap wakes the floor by itself. Timing comes from
the playback handle, never from a fixed beat.

**Files:**
- Create: `src/renderer/src/audio/speechDirector.ts`
- Create: `test/fixtures/speech-harness.cjs` (fake clock, timers and sink; Tasks 4 and 6 reuse it)
- Test: `test/tts-speech-director.test.cjs` (create)

**Interfaces:**
- Consumes: `SpokenIntent`, `PRIORITY_RANK` from `speechIntent.ts` (Task 2).
- Produces:
  - `interface SpeechPlaybackHandle { readonly durationMs: number; readonly ended: Promise<void>; stop(fadeMs?: number): void }`
  - `interface SpeechSink { prepare(i: SpokenIntent): Promise<void>; play(i: SpokenIntent, o: { gain: number; pan: number }): Promise<SpeechPlaybackHandle> }`
  - `interface DirectorClock { now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void; random(): number }`
  - `DIRECTOR_LIMITS` (the frozen numbers from the spec)
  - `class SpeechDirector` with `constructor(sink: SpeechSink, clock: DirectorClock)`,
    `enqueue(i: SpokenIntent): boolean`, `cancel(f: { conversationId?: string; agentId?: string }): void`,
    `stopAll(fadeMs?: number): Promise<void>`, `setMuted(m: boolean): void`,
    `disable(): void`, `get pendingCount(): number`, `get activeVoices(): number`.

Task 4 adds no new exported names — it fills in the policy inside this same class.

- [ ] **Step 1: Write the shared test fixture**

Create `test/fixtures/speech-harness.cjs`. Three suites use it (director, policy, wiring),
so it lives in `test/fixtures/` rather than being exported from a test file — requiring one
test file from another would re-run its cases in the second file's process.

```js
'use strict';

/** Fake clock, fake timers, fake sink. Nothing here touches audio or real time:
 *  clips "end" when the clock reaches their duration, which is exactly the
 *  contract the real mixer handle provides.
 *
 *  opts.random    — fixed value for the reply-gap jitter (default 0.5)
 *  opts.durations — { utteranceId: ms }, default 1000 ms per clip
 */
function harness(opts) {
  const options = opts || {};
  let t = 1000;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + Math.max(0, ms) });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    random: () => (options.random === undefined ? 0.5 : options.random)
  };

  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

  async function advance(ms) {
    const target = t + ms;
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, timer] of timers) if (timer.at < dueAt) { dueAt = timer.at; dueId = id; }
      if (dueId === null || dueAt > target) break;
      const timer = timers.get(dueId);
      timers.delete(dueId);
      t = dueAt;
      timer.fn();
      await flush();
    }
    t = target;
    await flush();
  }

  const log = { prepared: [], started: [], ended: [] };
  const durations = options.durations || {};
  const sink = {
    async prepare(intent) { log.prepared.push(intent.utteranceId); },
    async play(intent, playOpts) {
      const durationMs = durations[intent.utteranceId] === undefined
        ? 1000
        : durations[intent.utteranceId];
      log.started.push({ id: intent.utteranceId, at: t, gain: playOpts.gain, pan: playOpts.pan });
      let settle;
      const ended = new Promise((r) => { settle = r; });
      const finish = () => { log.ended.push({ id: intent.utteranceId, at: clock.now() }); settle(); };
      const timerId = clock.setTimer(finish, durationMs);
      return {
        durationMs,
        ended,
        stop() { clock.clearTimer(timerId); finish(); }
      };
    }
  };

  let n = 0;
  const intent = (over) => Object.assign({
    utteranceId: 'u' + (++n),
    agentId: 'a',
    voiceId: 'am_adam',
    text: 'morning',
    priority: 'ambient',
    eligibleAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    pan: 0
  }, over || {});

  return { clock, sink, log, advance, flush, intent, at: () => t };
}

module.exports = { harness };
```

- [ ] **Step 2: Write the failing test**

Create `test/tts-speech-director.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { harness } = require('./fixtures/speech-harness.cjs');

const { SpeechDirector, DIRECTOR_LIMITS } =
  loadTs('src/renderer/src/audio/speechDirector.ts');

test('a queued line plays without anyone calling enqueue again', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'first', agentId: 'a' }));
  d.enqueue(h.intent({ utteranceId: 'second', agentId: 'b' }));
  await h.flush();
  assert.deepEqual(h.log.started.map((s) => s.id), ['first']);

  // This is the regression: the old queue exited its pump inside the post-line
  // gap and only woke on the NEXT speak() call, so 'second' stayed silent.
  await h.advance(5000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['first', 'second']);
});

test('conversation beats play in order however they were queued', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', conversationId: 'c', beatIndex: 1, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', conversationId: 'c', beatIndex: 0, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b2', agentId: 'a', conversationId: 'c', beatIndex: 2, priority: 'conversation' }));
  await h.advance(10000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['b0', 'b1', 'b2']);
});

test('a reply starts inside the 200-450ms window after the previous speaker', async () => {
  const h = harness({ random: 0.5, durations: { b0: 1200 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', conversationId: 'c', beatIndex: 0, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', conversationId: 'c', beatIndex: 1, priority: 'conversation' }));
  await h.advance(6000);

  const endOfFirst = h.log.ended.find((e) => e.id === 'b0').at;
  const startOfReply = h.log.started.find((s) => s.id === 'b1').at;
  const gap = startOfReply - endOfFirst;
  assert.ok(gap >= DIRECTOR_LIMITS.replyGapMinMs, `gap ${gap} too short`);
  assert.ok(gap <= DIRECTOR_LIMITS.replyGapMaxMs, `gap ${gap} too long`);
});

test('the next turn is synthesized while the current one is still playing', async () => {
  const h = harness({ durations: { b0: 2000 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', conversationId: 'c', beatIndex: 0, priority: 'conversation' }));
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', conversationId: 'c', beatIndex: 1, priority: 'conversation' }));
  await h.flush();
  assert.deepEqual(h.log.prepared, ['b1'], 'the reply is prepared during beat 0');
  assert.deepEqual(h.log.started.map((s) => s.id), ['b0'], 'but not started early');
});

test('onStart carries the real clip length and onEnd waits for the audio', async () => {
  const h = harness({ durations: { solo: 1800 } });
  const d = new SpeechDirector(h.sink, h.clock);
  let startedWith = null;
  let endedAt = null;
  d.enqueue(h.intent({
    utteranceId: 'solo',
    onStart: (ms) => { startedWith = ms; },
    onEnd: () => { endedAt = h.at(); }
  }));
  await h.flush();
  assert.equal(startedWith, 1800, 'the caption is told the true duration');
  assert.equal(endedAt, null, 'and is not torn down before the audio finishes');
  await h.advance(1800);
  assert.equal(endedAt, 2800);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/tts-speech-director.test.cjs`
Expected: FAIL — `Cannot find module .../speechDirector.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/renderer/src/audio/speechDirector.ts`:

```ts
// Who speaks next, and exactly when.
//
// This replaces SpeechQueue, which had a fatal shape: it was a passive bag that
// only moved when someone called speak(). After a line finished, the 800 ms gap
// was still running, next() returned null, the pump exited — and nothing ever
// woke it. Pending lines sat silent until an unrelated enqueue happened to
// arrive. The director owns a timer instead, so every gap wakes the floor.
//
// The other change is that timing is AUDIO time, not visual time. A turn ends
// when its playback handle says so; replies are scheduled from that instant.
// Everything here is pure policy behind an injected clock, timer, RNG and sink,
// so the whole thing is testable under `node --test` with no audio at all.

import { PRIORITY_RANK, type SpokenIntent } from './speechIntent';

export interface SpeechPlaybackHandle {
  readonly durationMs: number;
  readonly ended: Promise<void>;
  stop(fadeMs?: number): void;
}

export interface SpeechSink {
  /** Synthesize ahead of time so the next turn can start the moment it is due. */
  prepare(intent: SpokenIntent): Promise<void>;
  /** Start this line now. Resolves once it is audible. */
  play(intent: SpokenIntent, opts: { gain: number; pan: number }): Promise<SpeechPlaybackHandle>;
}

export interface DirectorClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** 0..1, used only to jitter the reply gap. */
  random(): number;
}

export const DIRECTOR_LIMITS = {
  /** Pending utterances held at once, across the whole floor. */
  maxPending: 16,
  /** Pending beats held for any one conversation. */
  maxPerConversation: 6,
  /** A reply lands this long after the previous speaker stops. */
  replyGapMinMs: 200,
  replyGapMaxMs: 450,
  /** Silence between two lines that are NOT part of the same conversation. */
  socialGapMs: 900,
  /** Floor between two lines from the same agent, outside a conversation. */
  perAgentMs: 6000,
  /** Work-event reactions are rare on purpose. */
  reactionCooldownMs: 12000,
  /** A background remark may only start inside this much of a line's tail. */
  overlapWindowMs: 250,
  overlapGainDb: -12,
  /** Two voices at once, ever. */
  maxVoices: 2,
  /** Never sleep longer than this with work pending — cheap liveness insurance. */
  maxSleepMs: 500
} as const;

/** -12 dB as linear gain. Kept here so the director needs no audio import. */
const OVERLAP_GAIN = Math.pow(10, DIRECTOR_LIMITS.overlapGainDb / 20);

interface Active {
  intent: SpokenIntent;
  background: boolean;
  handle: SpeechPlaybackHandle | null;
  endsAt: number;
  /** Set when a stop was requested before the handle existed. */
  cancelled: boolean;
  fadeMs: number;
  settled: Promise<void>;
  settle: () => void;
}

export class SpeechDirector {
  private readonly pending: SpokenIntent[] = [];
  /** Arrival order, so equal-priority lines stay first-come-first-served. */
  private readonly arrival = new Map<string, number>();
  private arrivals = 0;
  private foreground: Active | null = null;
  private background: Active | null = null;
  private floorFreeAt = 0;
  private readonly lastSpokenAt = new Map<string, number>();
  private lastReactionAt = Number.NEGATIVE_INFINITY;
  private muted = false;
  private disabled = false;
  private timer: unknown = null;
  private ticking = false;
  private dirty = false;

  constructor(private readonly sink: SpeechSink, private readonly clock: DirectorClock) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  get activeVoices(): number {
    return (this.foreground ? 1 : 0) + (this.background ? 1 : 0);
  }

  /** Returns false when the line was refused outright (muted, disabled, bounded). */
  enqueue(intent: SpokenIntent): boolean {
    if (this.disabled || this.muted) {
      intent.onEnd?.();
      return false;
    }
    if (intent.conversationId !== undefined) {
      const held = this.pending.filter((p) => p.conversationId === intent.conversationId).length;
      if (held >= DIRECTOR_LIMITS.maxPerConversation) {
        intent.onEnd?.();
        return false;
      }
    }
    this.pending.push(intent);
    this.arrival.set(intent.utteranceId, ++this.arrivals);
    // Over the global bound, shed the least important, oldest line — which may
    // be the one that just arrived. A flood of ambient chatter must never push
    // out a conversation beat that is mid-exchange.
    while (this.pending.length > DIRECTOR_LIMITS.maxPending) {
      const worst = [...this.pending].sort((a, b) => this.rank(b) - this.rank(a))[0];
      this.drop(worst);
    }
    this.wake();
    return this.pending.includes(intent) || this.isActive(intent);
  }

  /** Drop pending lines and stop active ones matching the filter. Used when an
   *  agent leaves the café, resumes work, despawns, or the floor closes. */
  cancel(filter: { conversationId?: string; agentId?: string }): void {
    const matches = (i: SpokenIntent): boolean =>
      (filter.conversationId !== undefined && i.conversationId === filter.conversationId) ||
      (filter.agentId !== undefined && i.agentId === filter.agentId);

    for (const i of [...this.pending]) if (matches(i)) this.drop(i);
    for (const a of [this.foreground, this.background]) {
      if (a && matches(a.intent)) this.stopActive(a, 80);
    }
    this.wake();
  }

  /** Silence everything and resolve once the floor is really quiet. */
  async stopAll(fadeMs = 100): Promise<void> {
    this.clearTimer();
    for (const i of [...this.pending]) this.drop(i);
    const actives = [this.foreground, this.background].filter((a): a is Active => a !== null);
    for (const a of actives) this.stopActive(a, fadeMs);
    await Promise.all(actives.map((a) => a.settled));
  }

  /** Muting refuses new lines as well as stopping current ones: a line queued
   *  during a realtime session must not be waiting when the session ends. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) void this.stopAll(100);
    else this.wake();
  }

  /** Give up on floor speech for this session (repeated synthesis failure). */
  disable(): void {
    this.disabled = true;
    void this.stopAll(100);
  }

  // ── scheduling ─────────────────────────────────────────────────────────────

  private wake(): void {
    if (this.ticking) { this.dirty = true; return; }
    this.ticking = true;
    try {
      do { this.dirty = false; this.tick(); } while (this.dirty);
    } finally {
      this.ticking = false;
    }
  }

  private tick(): void {
    this.clearTimer();
    if (this.disabled || this.muted) return;
    const t = this.clock.now();
    this.dropExpired(t);

    // A background remark may slip into the tail of the foreground line.
    if (this.foreground && !this.background) {
      const remaining = this.foreground.endsAt - t;
      if (remaining > 0 && remaining <= DIRECTOR_LIMITS.overlapWindowMs) {
        const candidate = this.choose(t, true);
        if (candidate) this.start(candidate, true);
      }
    }

    if (!this.foreground && t >= this.floorFreeAt) {
      const next = this.choose(t, false);
      if (next) this.start(next, false);
    }

    this.schedule(t);
  }

  private schedule(t: number): void {
    if (!this.pending.length) return;               // nothing to wake up for
    let next = t + DIRECTOR_LIMITS.maxSleepMs;
    const consider = (time: number): void => {
      if (time > t && time < next) next = time;
    };
    consider(this.floorFreeAt);
    consider(this.lastReactionAt + DIRECTOR_LIMITS.reactionCooldownMs);
    if (this.foreground && !this.background) {
      consider(this.foreground.endsAt - DIRECTOR_LIMITS.overlapWindowMs);
    }
    for (const i of this.pending) { consider(i.eligibleAt); consider(i.expiresAt); }
    for (const last of this.lastSpokenAt.values()) consider(last + DIRECTOR_LIMITS.perAgentMs);
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.wake();
    }, Math.max(10, next - t));
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  // ── selection ──────────────────────────────────────────────────────────────

  /** Sort key: priority, then eligibility, then arrival. Higher is worse. */
  private rank(i: SpokenIntent): number {
    return PRIORITY_RANK[i.priority] * 1e12 + i.eligibleAt * 1e3 +
      (this.arrival.get(i.utteranceId) ?? 0);
  }

  /** The lowest outstanding beat index of a conversation — the only one eligible. */
  private headBeat(conversationId: string): number | undefined {
    let head: number | undefined;
    for (const i of this.pending) {
      if (i.conversationId !== conversationId) continue;
      const b = i.beatIndex ?? 0;
      if (head === undefined || b < head) head = b;
    }
    return head;
  }

  private choose(t: number, forOverlap: boolean): SpokenIntent | null {
    const fg = this.foreground;
    const usable = this.pending.filter((i) => {
      if (t < i.eligibleAt) return false;
      if (i.conversationId !== undefined && (i.beatIndex ?? 0) !== this.headBeat(i.conversationId)) {
        return false;                               // an earlier beat is still due
      }
      if (i.priority === 'reaction' &&
          t - this.lastReactionAt < DIRECTOR_LIMITS.reactionCooldownMs) {
        return false;
      }
      if (i.conversationId === undefined) {
        // Inside a conversation the per-agent floor would break turn-taking, so
        // it only applies to standalone lines.
        const last = this.lastSpokenAt.get(i.agentId);
        if (last !== undefined && t - last < DIRECTOR_LIMITS.perAgentMs) return false;
      }
      if (forOverlap) {
        if (!fg) return false;
        if (i.priority === 'conversation') return false;   // a beat is never a mumble
        if (i.agentId === fg.intent.agentId) return false; // never overlap yourself
        if (i.conversationId !== undefined &&
            i.conversationId === fg.intent.conversationId) return false;
      }
      return true;
    });
    if (!usable.length) return null;
    return usable.sort((a, b) => this.rank(a) - this.rank(b))[0];
  }

  // ── playback ───────────────────────────────────────────────────────────────

  private start(intent: SpokenIntent, background: boolean): void {
    this.remove(intent);
    const t = this.clock.now();
    let settle!: () => void;
    const settled = new Promise<void>((r) => { settle = r; });
    const active: Active = {
      intent, background, handle: null, endsAt: Number.POSITIVE_INFINITY,
      cancelled: false, fadeMs: 80, settled, settle
    };
    if (background) this.background = active; else this.foreground = active;

    this.lastSpokenAt.set(intent.agentId, t);
    if (intent.priority === 'reaction') this.lastReactionAt = t;

    void this.sink
      .play(intent, { gain: background ? OVERLAP_GAIN : 1, pan: intent.pan })
      .then((handle) => {
        active.handle = handle;
        if (active.cancelled) { handle.stop(active.fadeMs); return handle.ended; }
        active.endsAt = this.clock.now() + handle.durationMs;
        intent.onStart?.(handle.durationMs);
        if (!background) this.prepareAhead();
        this.wake();
        return handle.ended;
      })
      .then(() => this.finish(active))
      .catch(() => this.finish(active));   // a failed line must not wedge the floor
  }

  /** Warm the synthesizer for whatever is most likely to speak next, so the turn
   *  starts on time rather than after a model round-trip. */
  private prepareAhead(): void {
    const next = [...this.pending]
      .filter((i) => i.conversationId === undefined ||
        (i.beatIndex ?? 0) === this.headBeat(i.conversationId))
      .sort((a, b) => this.rank(a) - this.rank(b))[0];
    if (next) void this.sink.prepare(next).catch(() => { /* prepared lazily instead */ });
  }

  private finish(active: Active): void {
    if (active.background) {
      if (this.background === active) this.background = null;
    } else if (this.foreground === active) {
      this.foreground = null;
      this.floorFreeAt = this.clock.now() + this.gapAfter(active.intent);
    }
    active.intent.onEnd?.();
    active.settle();
    this.wake();
  }

  /** A reply lands tight; an unrelated line waits out a proper social beat. */
  private gapAfter(finished: SpokenIntent): number {
    const sameConversation = finished.conversationId !== undefined &&
      this.pending.some((i) => i.conversationId === finished.conversationId);
    if (!sameConversation) return DIRECTOR_LIMITS.socialGapMs;
    const span = DIRECTOR_LIMITS.replyGapMaxMs - DIRECTOR_LIMITS.replyGapMinMs;
    return DIRECTOR_LIMITS.replyGapMinMs + Math.floor(this.clock.random() * span);
  }

  private stopActive(active: Active, fadeMs: number): void {
    active.cancelled = true;
    active.fadeMs = fadeMs;
    active.handle?.stop(fadeMs);
  }

  private isActive(intent: SpokenIntent): boolean {
    return this.foreground?.intent === intent || this.background?.intent === intent;
  }

  // ── pending bookkeeping ────────────────────────────────────────────────────

  private remove(intent: SpokenIntent): void {
    const idx = this.pending.indexOf(intent);
    if (idx >= 0) this.pending.splice(idx, 1);
  }

  /** Remove a line that will never be spoken, telling its caller so the caption
   *  and any conversation state are torn down. */
  private drop(intent: SpokenIntent): void {
    this.remove(intent);
    this.arrival.delete(intent.utteranceId);
    intent.onEnd?.();
  }

  private dropExpired(t: number): void {
    for (const i of [...this.pending]) if (t >= i.expiresAt) this.drop(i);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/tts-speech-director.test.cjs`
Expected: PASS, 5 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/audio/speechDirector.ts test/fixtures/speech-harness.cjs test/tts-speech-director.test.cjs
git commit -m "feat(audio): self-waking speech director with audio-timed turn taking"
```

---

### Task 4: Director policy — priorities, cooldowns, bounds, cancellation, quiet overlap

Task 3 built the machine; this task proves the rules that keep it from becoming noise. No
new code is expected — every rule below is already written in `speechDirector.ts`. If a
test fails, the bug is in Task 3's implementation and belongs here.

**Files:**
- Modify: `src/renderer/src/audio/speechDirector.ts` (only if a test below fails)
- Test: `test/tts-director-policy.test.cjs` (create)

**Interfaces:**
- Consumes: everything Task 3 produced, plus `harness()` from `test/fixtures/speech-harness.cjs`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `test/tts-director-policy.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { harness } = require('./fixtures/speech-harness.cjs');

const { SpeechDirector, DIRECTOR_LIMITS } =
  loadTs('src/renderer/src/audio/speechDirector.ts');

test('a conversation beat outranks a reaction, which outranks small talk', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'chat', agentId: 'a', priority: 'ambient' }));
  d.enqueue(h.intent({ utteranceId: 'react', agentId: 'b', priority: 'reaction' }));
  d.enqueue(h.intent({ utteranceId: 'beat', agentId: 'c', priority: 'conversation', conversationId: 'k', beatIndex: 0 }));
  await h.advance(20000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['beat', 'react', 'chat']);
});

test('work-event reactions hold a 12 second global cooldown', async () => {
  const h = harness({ durations: { r1: 500, r2: 500 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'r1', agentId: 'a', priority: 'reaction' }));
  d.enqueue(h.intent({ utteranceId: 'r2', agentId: 'b', priority: 'reaction' }));
  await h.advance(5000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['r1'], 'the second reaction waits');
  await h.advance(DIRECTOR_LIMITS.reactionCooldownMs);
  assert.deepEqual(h.log.started.map((s) => s.id), ['r1', 'r2']);
});

test('an expired line is dropped unspoken and its caller is told', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  let ended = false;
  d.enqueue(h.intent({ utteranceId: 'hold', agentId: 'a' }));   // occupies the floor
  d.enqueue(h.intent({
    utteranceId: 'stale', agentId: 'b',
    expiresAt: h.at() + 400,
    onEnd: () => { ended = true; }
  }));
  await h.advance(3000);
  assert.equal(h.log.started.some((s) => s.id === 'stale'), false, 'its moment passed');
  assert.equal(ended, true, 'the caption must still be torn down');
});

test('pending speech is bounded globally and per conversation', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  // One plays immediately; the rest queue up.
  for (let i = 0; i < 30; i++) {
    d.enqueue(h.intent({ utteranceId: 'x' + i, agentId: 'a' + i, priority: 'ambient' }));
  }
  await h.flush();
  assert.ok(d.pendingCount <= DIRECTOR_LIMITS.maxPending, `pending ${d.pendingCount}`);

  const c = new SpeechDirector(h.sink, h.clock);
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    if (c.enqueue(h.intent({
      utteranceId: 'c' + i, agentId: i % 2 ? 'a' : 'b',
      priority: 'conversation', conversationId: 'one', beatIndex: i,
      eligibleAt: Number.MAX_SAFE_INTEGER   // keep them all pending
    }))) accepted++;
  }
  assert.equal(accepted, DIRECTOR_LIMITS.maxPerConversation);
});

test('cancelling a conversation drops its pending beats and stops the live one', async () => {
  const h = harness({ durations: { b0: 4000 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'b0', agentId: 'a', priority: 'conversation', conversationId: 'k', beatIndex: 0 }));
  d.enqueue(h.intent({ utteranceId: 'b1', agentId: 'b', priority: 'conversation', conversationId: 'k', beatIndex: 1 }));
  await h.flush();
  assert.equal(d.activeVoices, 1);

  d.cancel({ conversationId: 'k' });
  await h.advance(6000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['b0'], 'the reply never happens');
  assert.equal(d.activeVoices, 0, 'the live beat was cut short');
  assert.equal(d.pendingCount, 0);
});

test('cancelling an agent silences only that agent', async () => {
  const h = harness({ durations: { mine: 4000 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'mine', agentId: 'gone' }));
  d.enqueue(h.intent({ utteranceId: 'theirs', agentId: 'stays' }));
  await h.flush();
  d.cancel({ agentId: 'gone' });
  await h.advance(6000);
  assert.equal(h.log.started.some((s) => s.id === 'theirs'), true);
});

test('stopAll clears pending, stops the floor, and resolves on silence', async () => {
  const h = harness({ durations: { live: 5000 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'live', agentId: 'a' }));
  d.enqueue(h.intent({ utteranceId: 'waiting', agentId: 'b' }));
  await h.flush();

  await d.stopAll(100);
  assert.equal(d.activeVoices, 0);
  assert.equal(d.pendingCount, 0);
  await h.advance(20000);
  assert.equal(h.log.started.some((s) => s.id === 'waiting'), false, 'nothing resumes');
});

test('at most one quiet background remark, only in the last 250ms, never self', async () => {
  const h = harness({ durations: { long: 3000 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'long', agentId: 'a', pan: -0.5 }));
  await h.flush();

  // Same agent: refused however close to the end we get.
  d.enqueue(h.intent({ utteranceId: 'self', agentId: 'a' }));
  // A different agent: eligible only inside the tail.
  d.enqueue(h.intent({ utteranceId: 'mumble', agentId: 'b', pan: 0.7 }));
  d.enqueue(h.intent({ utteranceId: 'third', agentId: 'c' }));

  await h.advance(2600);   // 400ms left — outside the overlap window
  assert.deepEqual(h.log.started.map((s) => s.id), ['long']);

  await h.advance(200);    // 200ms left — inside it
  const ids = h.log.started.map((s) => s.id);
  assert.deepEqual(ids, ['long', 'mumble'], 'exactly one background remark');
  assert.equal(d.activeVoices, DIRECTOR_LIMITS.maxVoices);

  const bg = h.log.started.find((s) => s.id === 'mumble');
  assert.ok(Math.abs(bg.gain - 0.2512) < 0.001, 'background sits 12 dB down');
  assert.equal(bg.pan, 0.7, 'and is panned to its speaker');
});

test('outside a conversation one agent cannot monopolise the floor', async () => {
  const h = harness({ durations: { one: 300, two: 300, other: 300 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'one', agentId: 'a' }));
  await h.advance(2000);
  d.enqueue(h.intent({ utteranceId: 'two', agentId: 'a' }));
  d.enqueue(h.intent({ utteranceId: 'other', agentId: 'b' }));
  await h.advance(2000);
  const ids = h.log.started.map((s) => s.id);
  assert.deepEqual(ids, ['one', 'other'], 'agent a is inside its 6s floor');
  await h.advance(DIRECTOR_LIMITS.perAgentMs);
  assert.equal(h.log.started.some((s) => s.id === 'two'), true);
});

test('identical text from two agents is still two cancellable utterances', async () => {
  const h = harness({ durations: { same1: 400, same2: 400 } });
  const d = new SpeechDirector(h.sink, h.clock);
  d.enqueue(h.intent({ utteranceId: 'same1', agentId: 'a', text: 'is it pretzel day' }));
  d.enqueue(h.intent({ utteranceId: 'same2', agentId: 'b', text: 'is it pretzel day' }));
  d.cancel({ agentId: 'b' });
  await h.advance(8000);
  assert.deepEqual(h.log.started.map((s) => s.id), ['same1']);
});

test('a muted floor accepts nothing and stays silent', async () => {
  const h = harness();
  const d = new SpeechDirector(h.sink, h.clock);
  d.setMuted(true);
  assert.equal(d.enqueue(h.intent({ utteranceId: 'nope', agentId: 'a' })), false);
  await h.advance(10000);
  assert.equal(h.log.started.length, 0);

  d.setMuted(false);
  await h.advance(1000);
  assert.equal(h.log.started.length, 0, 'unmuting must not replay refused lines');
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/tts-director-policy.test.cjs`
Expected: PASS, 11 tests, against Task 3's implementation as written.

If any fail, fix `src/renderer/src/audio/speechDirector.ts` — the tests encode the spec and
the implementation is the thing that moves. Two failures to expect if Task 3 was typed
loosely: `choose()` must return `null` (not `undefined`) when nothing is usable, and
`enqueue()` must return `false` for a line it immediately sheds under the global bound.

- [ ] **Step 3: Run the whole suite and typecheck**

Run: `npm run test:focused`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/audio/speechDirector.ts test/tts-director-policy.test.cjs
git commit -m "test(audio): pin director priorities, cooldowns, bounds, cancellation, overlap"
```

---
### Task 5: Bounded PCM cache and bounded synthesis failure

Two ways the current engine can hurt a long session: the cache counts entries but not bytes,
and a wedged worker leaves `synth()` pending forever, which would hang the director's
`play()` and hold the floor silent with no way out.

**Files:**
- Modify: `src/renderer/src/audio/ttsCache.ts`
- Modify: `src/renderer/src/audio/ttsEngine.ts`
- Test: `test/tts-cache.test.cjs` (extend)
- Test: `test/tts-engine-recovery.test.cjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `PCM_CACHE_LIMITS = { entries: 200, bytes: 67108864 }` from `ttsCache.ts`
  - `class TtsCache<T>` with `constructor(capacity?: number, maxBytes?: number, sizeOf?: (v: T) => number)`
    and `get totalBytes(): number`
  - `type WorkerFactory = () => Worker` and
    `class KokoroProvider` with `constructor(makeWorker: WorkerFactory, opts?: { synthTimeoutMs?: number })`
    and `get disabled(): boolean`
  - `SYNTH_TIMEOUT_MS = 15000` from `ttsEngine.ts`
  - `TtsProvider` gains `readonly disabled: boolean`

- [ ] **Step 1: Write the failing cache test**

Append to `test/tts-cache.test.cjs`:

```js
const { PCM_CACHE_LIMITS } = loadTs('src/renderer/src/audio/ttsCache.ts');

test('the cache evicts on bytes as well as on entry count', () => {
  // 1 KiB entries, a 4 KiB budget: the fifth insert pushes out the oldest.
  const cache = new TtsCache(200, 4096, (v) => v.bytes);
  for (let i = 0; i < 4; i++) cache.set('k' + i, { bytes: 1024 });
  assert.equal(cache.size, 4);
  assert.equal(cache.totalBytes, 4096);

  cache.set('k4', { bytes: 1024 });
  assert.equal(cache.size, 4, 'the byte budget held');
  assert.equal(cache.has('k0'), false, 'the least recently used went first');
  assert.equal(cache.totalBytes, 4096);
});

test('a read protects an entry from the byte eviction that follows', () => {
  const cache = new TtsCache(200, 3072, (v) => v.bytes);
  cache.set('a', { bytes: 1024 });
  cache.set('b', { bytes: 1024 });
  cache.set('c', { bytes: 1024 });
  cache.get('a');                       // 'a' is young again; 'b' is now oldest
  cache.set('d', { bytes: 1024 });
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
});

test('the shipped budget is 200 entries and 64 MiB', () => {
  assert.equal(PCM_CACHE_LIMITS.entries, 200);
  assert.equal(PCM_CACHE_LIMITS.bytes, 64 * 1024 * 1024);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/tts-cache.test.cjs`
Expected: FAIL — `PCM_CACHE_LIMITS` is undefined and `cache.totalBytes` is undefined.

- [ ] **Step 3: Add the byte budget**

In `src/renderer/src/audio/ttsCache.ts`, add the limits constant above the class and replace
the class body (the `normalizeText`, `cacheKey` and `InFlight` exports are unchanged):

```ts
/** A minute of Kokoro speech at 24 kHz mono float is about 5.5 MiB. 64 MiB is
 *  roughly ten minutes of distinct lines — far more than the finite banter pool
 *  needs, and a hard ceiling on a session that never stops. */
export const PCM_CACHE_LIMITS = { entries: 200, bytes: 64 * 1024 * 1024 } as const;

/** Insertion-ordered Map used as an LRU: re-inserting on read moves an entry to
 *  the young end, so the first key iterated is always the least recently used.
 *  Bounded on BOTH entry count and total bytes — 200 long lines is a lot of
 *  memory, and 200 short ones is almost none. */
export class TtsCache<T> {
  private readonly map = new Map<string, T>();
  private readonly sizes = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly capacity = PCM_CACHE_LIMITS.entries,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: T) => number = () => 0
  ) {}

  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    const size = this.sizes.get(key) ?? 0;
    this.map.delete(key);
    this.sizes.delete(key);
    this.map.set(key, value);
    this.sizes.set(key, size);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.evict(key);
    const size = this.sizeOf(value);
    this.map.set(key, value);
    this.sizes.set(key, size);
    this.total += size;
    while (this.map.size > this.capacity || (this.total > this.maxBytes && this.map.size > 1)) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
  }

  private evict(key: string): void {
    this.total -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get totalBytes(): number {
    return this.total;
  }
}
```

- [ ] **Step 4: Run the cache test to verify it passes**

Run: `node --test test/tts-cache.test.cjs`
Expected: PASS, including the three new cases.

- [ ] **Step 5: Write the failing engine-recovery test**

Create `test/tts-engine-recovery.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { KokoroProvider, SYNTH_TIMEOUT_MS } = loadTs('src/renderer/src/audio/ttsEngine.ts');

/** A worker that answers `warm`/`voices`, and answers `synth` only when told to.
 *  `hang` makes it swallow synth requests, which is what a wedged model looks
 *  like from the main thread. */
function fakeWorker(state) {
  const worker = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      state.posted.push(msg);
      const reply = (data) => {
        if (worker.onmessage) worker.onmessage({ data: Object.assign({ id: msg.id }, data) });
      };
      if (msg.type === 'warm') return reply({ type: 'ready' });
      if (msg.type === 'voices') return reply({ type: 'voices', voices: ['am_adam'] });
      if (state.hang) return;                       // the wedge
      reply({ type: 'audio', pcm: new Float32Array(8), sampleRate: 24000 });
    },
    terminate() { worker.terminated = true; }
  };
  state.workers.push(worker);
  return worker;
}

const newState = () => ({ posted: [], workers: [], hang: false });

test('the shipped synthesis timeout is fifteen seconds', () => {
  assert.equal(SYNTH_TIMEOUT_MS, 15000);
});

test('a wedged worker times out, is restarted once, and the retry succeeds', async () => {
  const state = newState();
  const provider = new KokoroProvider(() => fakeWorker(state), { synthTimeoutMs: 20 });
  state.hang = true;
  // Let the retry land on a healthy worker.
  setTimeout(() => { state.hang = false; }, 5);

  const out = await provider.synth('morning', 'am_adam');
  assert.equal(out.sampleRate, 24000);
  assert.equal(state.workers.length, 2, 'the wedged worker was replaced');
  assert.equal(state.workers[0].terminated, true);
  assert.equal(provider.disabled, false);
});

test('a second failure disables floor speech for the session', async () => {
  const state = newState();
  const provider = new KokoroProvider(() => fakeWorker(state), { synthTimeoutMs: 20 });
  state.hang = true;

  await assert.rejects(provider.synth('morning', 'am_adam'));
  assert.equal(provider.disabled, true, 'one restart, then give up');

  // Later calls fail immediately rather than waiting out another timeout.
  const before = Date.now();
  await assert.rejects(provider.synth('afternoon', 'am_adam'));
  assert.ok(Date.now() - before < 20, 'a disabled provider does not wait');
});

test('a cached line is returned without touching the worker', async () => {
  const state = newState();
  const provider = new KokoroProvider(() => fakeWorker(state), { synthTimeoutMs: 20 });
  await provider.synth('morning', 'am_adam');
  const synths = state.posted.filter((m) => m.type === 'synth').length;
  await provider.synth('  MORNING ', 'am_adam');
  assert.equal(state.posted.filter((m) => m.type === 'synth').length, synths);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/tts-engine-recovery.test.cjs`
Expected: FAIL — `ttsEngine.ts` cannot even load, because `new Worker(new URL('./ttsWorker.ts',
import.meta.url))` uses `import.meta`, which `test/load-ts.cjs` cannot transpile to CommonJS.
That is the reason the worker becomes a constructor argument in the next step.

- [ ] **Step 7: Make the engine injectable, bounded and recoverable**

In `src/renderer/src/audio/ttsEngine.ts`:

1. Extend the file header comment:

```ts
// Main-thread face of the synth worker.
//
// Owns the worker, the LRU cache and request coalescing, and hides all of it
// behind TtsProvider so a cloud or system-voice provider can be swapped in later
// without any caller changing.
//
// The worker is CONSTRUCTED BY THE CALLER (index.ts) rather than here: `new
// URL('./ttsWorker.ts', import.meta.url)` cannot be transpiled to CommonJS, and
// keeping it out of this file is what lets the recovery policy below be tested
// under `node --test` at all.
//
// Recovery is deliberately short: synthesis that has not answered in 15s means a
// wedged model, not a slow one. The worker is replaced once; a second failure
// disables floor speech for the rest of the session, leaving the app, the
// ambience and every volume control working.
```

2. Add the imports and constants:

```ts
import { TtsCache, InFlight, cacheKey, PCM_CACHE_LIMITS } from './ttsCache';
import type { WorkerRequest, WorkerResponse } from './ttsWorker';

/** A model that has not answered in this long is wedged, not slow. */
export const SYNTH_TIMEOUT_MS = 15000;

export type WorkerFactory = () => Worker;
```

3. Add `disabled` to the interface:

```ts
export interface TtsProvider {
  /** Synthesize one line. Cached results resolve immediately. */
  synth(text: string, voiceId: string): Promise<SynthResult>;
  /** Voice ids the loaded model actually offers. */
  voices(): Promise<string[]>;
  /** Pay the model-load cost up front so the first real quip is not late. */
  warm(): Promise<void>;
  /** True once synthesis has failed twice — the floor stays quiet this session. */
  readonly disabled: boolean;
  dispose(): void;
}
```

4. Replace the class internals:

```ts
export class KokoroProvider implements TtsProvider {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private readonly cache = new TtsCache<SynthResult>(
    PCM_CACHE_LIMITS.entries,
    PCM_CACHE_LIMITS.bytes,
    (r) => r.pcm.byteLength
  );
  private readonly flight = new InFlight<SynthResult>();
  private restarted = false;
  private dead = false;
  private readonly synthTimeoutMs: number;

  constructor(
    private readonly makeWorker: WorkerFactory,
    opts: { synthTimeoutMs?: number } = {}
  ) {
    this.synthTimeoutMs = opts.synthTimeoutMs ?? SYNTH_TIMEOUT_MS;
  }

  get disabled(): boolean {
    return this.dead;
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = this.makeWorker();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.waiting.get(event.data.id);
      if (!pending) return;
      this.waiting.delete(event.data.id);
      if (event.data.type === 'error') pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    };
    worker.onerror = (event) => {
      // A worker-level failure orphans every outstanding request; fail them all
      // rather than leaving the floor waiting forever on a dead worker.
      const err = new Error(event.message || 'tts worker failed');
      for (const [, p] of this.waiting) p.reject(err);
      this.waiting.clear();
    };
    this.worker = worker;
    return worker;
  }

  private send(msg: Omit<WorkerRequest, 'id'>, timeoutMs = 0): Promise<WorkerResponse> {
    const worker = this.ensure();
    const id = ++this.seq;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.waiting.delete(id);
            reject(new Error(`tts synthesis timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      const clear = (): void => { if (timer !== null) clearTimeout(timer); };
      this.waiting.set(id, {
        resolve: (r) => { clear(); resolve(r); },
        reject: (e) => { clear(); reject(e); }
      });
      worker.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  async warm(): Promise<void> {
    await this.send({ type: 'warm' } as Omit<WorkerRequest, 'id'>);
  }

  async voices(): Promise<string[]> {
    const res = await this.send({ type: 'voices' } as Omit<WorkerRequest, 'id'>);
    return res.type === 'voices' ? res.voices : [];
  }

  async synth(text: string, voiceId: string): Promise<SynthResult> {
    if (this.dead) throw new Error('floor speech is disabled for this session');
    const key = cacheKey(voiceId, text);
    const hit = this.cache.get(key);
    if (hit) return hit;
    return this.flight.run(key, async () => {
      try {
        return await this.once(text, voiceId, key);
      } catch (err) {
        if (this.restarted) {
          // A previous call already spent the restart. Two failures is enough.
          this.dead = true;
          this.dispose();
          throw err;
        }
        // One clean restart. A wedged worker never recovers on its own, and the
        // orphaned request would otherwise hold the floor silent forever.
        this.restarted = true;
        this.dispose();
        try {
          return await this.once(text, voiceId, key);
        } catch (retryErr) {
          this.dead = true;
          this.dispose();
          throw retryErr;
        }
      }
    });
  }

  private async once(text: string, voiceId: string, key: string): Promise<SynthResult> {
    const res = await this.send(
      { type: 'synth', text, voiceId } as Omit<WorkerRequest, 'id'>,
      this.synthTimeoutMs
    );
    if (res.type !== 'audio') throw new Error('unexpected synth response');
    const out: SynthResult = { pcm: res.pcm, sampleRate: res.sampleRate };
    this.cache.set(key, out);
    return out;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, p] of this.waiting) p.reject(new Error('tts worker disposed'));
    this.waiting.clear();
  }
}
```

Note the nested `try` around the retry: the second recovery test expects `disabled` to be
true after a SINGLE `synth()` call whose retry also failed, so the retry's rejection must
set `dead` on that same call rather than waiting for a later one.

- [ ] **Step 8: Run the engine test to verify it passes**

Run: `node --test test/tts-engine-recovery.test.cjs`
Expected: PASS, 4 tests.

- [ ] **Step 9: Fix the one caller and typecheck**

`src/renderer/src/audio/index.ts` constructs `new KokoroProvider()`. Give it the factory it
now needs (Task 6 rewrites this file; this keeps the build green in between):

```ts
    this.provider = new KokoroProvider(
      () => new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' })
    );
```

Run: `npm run typecheck && npm run test:focused`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/audio/ttsCache.ts src/renderer/src/audio/ttsEngine.ts src/renderer/src/audio/index.ts test/tts-cache.test.cjs test/tts-engine-recovery.test.cjs
git commit -m "feat(audio): bound the PCM cache in bytes and bound synthesis failure"
```

---

### Task 6: Wire the director in, and make the microphone win

The pieces exist; nothing uses them yet. This task splits the singleton into a testable
speech half and a thin composition root, deletes the old queue, and adds the mic hand-off.

**Files:**
- Create: `src/renderer/src/audio/officeSpeech.ts`
- Modify: `src/renderer/src/audio/index.ts`
- Modify: `src/renderer/src/audio/ambience.ts` (add `fadeStop`)
- Delete: `src/renderer/src/audio/speechQueue.ts`
- Delete: `test/tts-speech-queue.test.cjs`
- Test: `test/tts-office-speech.test.cjs` (create)

`index.ts` keeps importing `ambience.ts`, which uses `import.meta.glob` and therefore cannot
be loaded by `test/load-ts.cjs`. That is exactly why the speech half moves into its own file:
`officeSpeech.ts` imports only mixer types, the director, the intent guard and the voice
cast, so the wiring under test is loadable.

**Interfaces:**
- Consumes: `Mixer`/`SpeechPlayback` (Task 1), `SpokenIntent`/`isSpeakable`/`SpeechPriority`
  (Task 2), `SpeechDirector`/`SpeechSink`/`DirectorClock` (Task 3), `TtsProvider` (Task 5),
  `voiceForAgent` (existing).
- Produces:
  - `interface SpeakOptions` (the fields listed in the implementation below)
  - `class OfficeSpeech` with `constructor(deps: { mixer: Mixer; provider: TtsProvider | null; clock?: DirectorClock })`,
    `setAvailableVoices(v: string[]): void`, `setEnabled(on: boolean): void`,
    `speak(o: SpeakOptions): string | null`, `cancelConversation(id: string): void`,
    `cancelAgent(id: string): void`, `setMuted(m: boolean): void`,
    `silence(fadeMs?: number): Promise<void>`, `release(): void`, `disable(): void`,
    `get pendingCount(): number`, `get activeVoices(): number`
  - `officeAudio` singleton in `index.ts` gains `silenceForMic(): Promise<void>`,
    `resumeAfterMic(): void`, `cancelConversation(id)`, `cancelAgent(id)`, and `speak()`
    now returns `string | null`
  - `Ambience.fadeStop(ms?: number): void`

- [ ] **Step 1: Write the failing test**

Create `test/tts-office-speech.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { harness } = require('./fixtures/speech-harness.cjs');

const { OfficeSpeech } = loadTs('src/renderer/src/audio/officeSpeech.ts');

/** A mixer stand-in whose clips end when the fake clock says so. */
function fakeMixer(h, durationMs) {
  const played = [];
  return {
    played,
    stopAllSpeech: async () => {},
    playSpeech: async (_clip, opts) => {
      played.push(opts);
      let settle;
      const ended = new Promise((r) => { settle = r; });
      const timerId = h.clock.setTimer(() => settle(), durationMs);
      return {
        durationMs,
        ended,
        stop() { h.clock.clearTimer(timerId); settle(); }
      };
    }
  };
}

function fakeProvider() {
  const asked = [];
  return {
    asked,
    disabled: false,
    async warm() {},
    async voices() { return ['am_adam', 'af_sarah']; },
    async synth(text, voiceId) { asked.push({ text, voiceId }); return { pcm: new Float32Array(4), sampleRate: 24000 }; },
    dispose() {}
  };
}

function build(h, durationMs) {
  const mixer = fakeMixer(h, durationMs === undefined ? 1000 : durationMs);
  const provider = fakeProvider();
  const speech = new OfficeSpeech({ mixer, provider, clock: h.clock });
  speech.setAvailableVoices(['am_adam', 'af_sarah']);
  speech.setEnabled(true);
  return { speech, mixer, provider };
}

test('a spoken line captions on real playback start and clears on audio end', async () => {
  const h = harness();
  const { speech } = build(h, 1700);
  let shownFor = null;
  let cleared = false;
  const id = speech.speak({
    agentId: 'a1', character: 'jim', text: 'morning',
    onStart: (ms) => { shownFor = ms; },
    onEnd: () => { cleared = true; }
  });
  assert.equal(typeof id, 'string');
  await h.flush();
  assert.equal(shownFor, 1700, 'the caption appears when audio starts, not when queued');
  assert.equal(cleared, false);
  await h.advance(1700);
  assert.equal(cleared, true);
});

test('work data is refused before it can reach the synthesizer', async () => {
  const h = harness();
  const { speech, provider } = build(h);
  assert.equal(speech.speak({ agentId: 'a1', character: 'jim', text: 'edit src/main/index.ts' }), null);
  assert.equal(speech.speak({ agentId: 'a1', character: 'jim', text: 'bash npm test' }), null);
  await h.flush();
  assert.deepEqual(provider.asked, [], 'nothing was synthesized');
});

test('the coordinator never speaks on the floor', async () => {
  const h = harness();
  const { speech } = build(h);
  assert.equal(speech.speak({ agentId: 'god', isGod: true, text: 'morning' }), null);
});

test('silence() stops the floor and refuses new lines until release()', async () => {
  const h = harness();
  const { speech } = build(h, 5000);
  speech.speak({ agentId: 'a1', character: 'jim', text: 'morning' });
  await h.flush();
  assert.equal(speech.activeVoices, 1);

  await speech.silence(100);
  assert.equal(speech.activeVoices, 0, 'the mic must not open over a live line');
  assert.equal(speech.speak({ agentId: 'a2', character: 'pam', text: 'morning' }), null);

  speech.release();
  const id = speech.speak({ agentId: 'a2', character: 'pam', text: 'morning' });
  assert.equal(typeof id, 'string', 'new chatter is allowed once the mic is closed');
});

test('two beats of one conversation are voiced in order by their two agents', async () => {
  const h = harness();
  const { speech, mixer } = build(h, 800);
  speech.speak({ agentId: 'a1', character: 'jim', text: 'is the build green', priority: 'conversation', conversationId: 'x', beatIndex: 0, pan: -0.4 });
  speech.speak({ agentId: 'a2', character: 'pam', text: 'do not look', priority: 'conversation', conversationId: 'x', beatIndex: 1, pan: 0.4 });
  await h.advance(4000);
  assert.deepEqual(mixer.played.map((p) => p.pan), [-0.4, 0.4]);
});

test('cancelling a conversation silences its remaining beats', async () => {
  const h = harness();
  const { speech, mixer } = build(h, 800);
  speech.speak({ agentId: 'a1', character: 'jim', text: 'is the build green', priority: 'conversation', conversationId: 'x', beatIndex: 0 });
  speech.speak({ agentId: 'a2', character: 'pam', text: 'do not look', priority: 'conversation', conversationId: 'x', beatIndex: 1 });
  await h.flush();
  speech.cancelConversation('x');
  await h.advance(4000);
  assert.equal(mixer.played.length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/tts-office-speech.test.cjs`
Expected: FAIL — `Cannot find module .../officeSpeech.ts`.

- [ ] **Step 3: Write `officeSpeech.ts`**

Create `src/renderer/src/audio/officeSpeech.ts`:

```ts
// Everything about making an agent audible, in one testable place.
//
// This is the half of the old `officeAudio` singleton that has no ambience and
// no asset loading, so `test/load-ts.cjs` can load it and the wiring — voice
// casting, the privacy guard, caption timing, the mic hand-off — is covered by
// real tests rather than by hoping.
//
// The privacy rule lives at this boundary on purpose: `isSpeakable` is the last
// thing between a string and the synthesizer, and the ONLY callers that should
// ever reach it are the banter pools in cafeteriaLines.ts and reactionLines.ts.

import type { Mixer } from './mixer';
import type { TtsProvider } from './ttsEngine';
import { SpeechDirector, type DirectorClock, type SpeechSink } from './speechDirector';
import { isSpeakable, type SpeechPriority, type SpokenIntent } from './speechIntent';
import { voiceForAgent } from './voiceCast';
import type { OfficeCharacterName } from '../scene/office/cast';

/** How long a line may wait before its moment has simply passed. */
const DEFAULT_TTL_MS = 8000;
/** The floor must be silent this fast when a microphone opens. */
export const MIC_FADE_MS = 100;

export interface SpeakOptions {
  agentId: string;
  character?: OfficeCharacterName | null;
  isGod?: boolean;
  /** Must come from a banter pool — see the privacy rule above. */
  text: string;
  /** Default 'ambient'. */
  priority?: SpeechPriority;
  /** Set on every beat of one exchange so it can be ordered and cancelled. */
  conversationId?: string;
  beatIndex?: number;
  /** Speaker's stereo position, -1..1. Default centre. */
  pan?: number;
  /** Dropped unspoken after this long. Default 8s. */
  ttlMs?: number;
  /** Fired when audio really starts, with the clip length: show the caption here. */
  onStart?: (durationMs: number) => void;
  /** Fired when audio ends, is cut short, or the line is dropped unspoken. */
  onEnd?: () => void;
}

const realClock: DirectorClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random()
};

export interface OfficeSpeechDeps {
  mixer: Mixer;
  provider: TtsProvider | null;
  clock?: DirectorClock;
}

export class OfficeSpeech {
  private readonly mixer: Mixer;
  private provider: TtsProvider | null;
  private readonly director: SpeechDirector;
  private availableVoices: string[] = [];
  private enabled = true;
  /** How many microphones are open. Speech is refused while this is above zero. */
  private micHolds = 0;
  private utterances = 0;

  constructor(deps: OfficeSpeechDeps) {
    this.mixer = deps.mixer;
    this.provider = deps.provider;
    this.director = new SpeechDirector(this.makeSink(), deps.clock ?? realClock);
  }

  setAvailableVoices(voices: string[]): void {
    this.availableVoices = voices;
  }

  /** The Settings speech toggle. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) void this.director.stopAll(MIC_FADE_MS);
  }

  setProvider(provider: TtsProvider | null): void {
    this.provider = provider;
    if (!provider) this.director.disable();
  }

  /** Silence the whole floor for the length of a realtime session. */
  setMuted(muted: boolean): void {
    this.director.setMuted(muted);
  }

  disable(): void {
    this.director.disable();
  }

  get pendingCount(): number {
    return this.director.pendingCount;
  }

  get activeVoices(): number {
    return this.director.activeVoices;
  }

  /** Ask for a line. Returns its utterance id, or null if it was refused —
   *  disabled, muted, a mic is open, the god, no voice, or unspeakable text.
   *  A refusal here does NOT fire `onEnd`: nothing was ever shown. */
  speak(opts: SpeakOptions): string | null {
    if (!this.enabled || this.micHolds > 0 || !this.provider) return null;
    if (!isSpeakable(opts.text)) {
      // Loud on purpose: reaching here means something upstream tried to speak
      // work data, which is a bug in the caller, not a line to quietly drop.
      console.warn('[audio] refused a line that is not from a banter pool');
      return null;
    }
    const voiceId = voiceForAgent({
      character: opts.character ?? null,
      agentId: opts.agentId,
      isGod: opts.isGod,
      available: this.availableVoices.length ? this.availableVoices : undefined
    });
    if (!voiceId) return null;                       // the god speaks elsewhere

    const now = Date.now();
    const utteranceId = `${opts.agentId}#${++this.utterances}`;
    const intent: SpokenIntent = {
      utteranceId,
      agentId: opts.agentId,
      voiceId,
      text: opts.text,
      priority: opts.priority ?? 'ambient',
      conversationId: opts.conversationId,
      beatIndex: opts.beatIndex,
      eligibleAt: now,
      expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
      pan: opts.pan ?? 0,
      onStart: opts.onStart,
      onEnd: opts.onEnd
    };
    return this.director.enqueue(intent) ? utteranceId : null;
  }

  cancelConversation(conversationId: string): void {
    this.director.cancel({ conversationId });
  }

  cancelAgent(agentId: string): void {
    this.director.cancel({ agentId });
  }

  /** Fade the floor out and RESOLVE ONLY WHEN IT IS SILENT. Every caller that is
   *  about to open a microphone must await this: an agent talking into a live mic
   *  gets transcribed as the user. Balanced by release(). */
  async silence(fadeMs = MIC_FADE_MS): Promise<void> {
    this.micHolds++;
    await this.director.stopAll(fadeMs);
    await this.mixer.stopAllSpeech(fadeMs);
  }

  /** The microphone is closed. Only NEW chatter resumes — nothing is replayed. */
  release(): void {
    this.micHolds = Math.max(0, this.micHolds - 1);
  }

  private makeSink(): SpeechSink {
    return {
      prepare: async (intent) => {
        // Best effort: a prepare failure just means the line synthesizes late.
        await this.provider?.synth(intent.text, intent.voiceId);
      },
      play: async (intent, opts) => {
        const provider = this.provider;
        if (!provider) throw new Error('no tts provider');
        let clip;
        try {
          clip = await provider.synth(intent.text, intent.voiceId);
        } catch (err) {
          if (provider.disabled) {
            console.warn('[audio] floor speech disabled for this session:', err);
            this.director.disable();
          }
          throw err;
        }
        return this.mixer.playSpeech(clip, { gain: opts.gain, pan: opts.pan });
      }
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/tts-office-speech.test.cjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Give the ambience a fade-stop**

In `src/renderer/src/audio/ambience.ts`, add after `stop()`:

```ts
  /** Fade the room out within `ms` and stop it. `stop()` cuts instantly, which is
   *  audible as a click; the microphone hand-off needs quiet, not abrupt. */
  fadeStop(ms = 100): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ctx = this.mixer.context;
    const g = this.mixer.ambienceBus.gain;
    const t = ctx.currentTime;
    const end = t + Math.max(0, ms) / 1000;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, end);
    try {
      this.loopSource?.stop(end);
    } catch {
      // Already stopped (double stop, or the context went away) — nothing to do.
    }
    this.loopSource = null;
  }
```

- [ ] **Step 6: Rewrite `index.ts` as a thin composition root**

Replace `src/renderer/src/audio/index.ts` with:

```ts
// One singleton the scene talks to. Everything above this file is testable in
// isolation; this is the only place they are wired together.
//
// The speech half lives in officeSpeech.ts so it can be loaded under
// `node --test` — this file imports ambience.ts, whose `import.meta.glob` cannot
// be transpiled to CommonJS.

import { KokoroProvider, type TtsProvider } from './ttsEngine';
import { Mixer } from './mixer';
import { Ambience, type AmbienceEvent } from './ambience';
import { OfficeSpeech, MIC_FADE_MS, type SpeakOptions } from './officeSpeech';

export type { SpeakOptions } from './officeSpeech';

export interface AudioConfig {
  master: number;
  speech: boolean;
  speechVolume: number;
  ambience: boolean;
  ambienceVolume: number;
}

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  master: 0.5,
  speech: true,
  speechVolume: 1,
  ambience: true,
  ambienceVolume: 0.6
};

export class OfficeAudio {
  private mixer: Mixer | null = null;
  private provider: TtsProvider | null = null;
  private ambience: Ambience | null = null;
  private speech: OfficeSpeech | null = null;
  private config: AudioConfig = { ...DEFAULT_AUDIO_CONFIG };
  private starting: Promise<void> | null = null;
  private micHolds = 0;

  /** Safe to call repeatedly; the model is loaded once. */
  init(): Promise<void> {
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<void> {
    const mixer = new Mixer();
    this.mixer = mixer;
    this.ambience = new Ambience(mixer);
    this.provider = new KokoroProvider(
      () => new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' })
    );
    this.speech = new OfficeSpeech({ mixer, provider: this.provider });
    this.applyConfig(this.config);
    // A microphone may have opened while the model was loading.
    for (let i = 0; i < this.micHolds; i++) void this.speech.silence(MIC_FADE_MS);

    try {
      // Pay the model-load cost now so the first real quip is not seconds late.
      await this.provider.warm();
      this.speech.setAvailableVoices(await this.provider.voices());
    } catch (err) {
      // A missing or broken model must not take the office floor down with it:
      // the room keeps its ambience and the agents simply stay quiet.
      console.warn('[audio] TTS unavailable, agents will not speak:', err);
      this.provider = null;
      this.speech.setProvider(null);
    }
  }

  applyConfig(cfg: AudioConfig): void {
    this.config = cfg;
    this.mixer?.setMaster(cfg.master);
    this.mixer?.setSpeechVolume(cfg.speechVolume);
    this.mixer?.setAmbienceVolume(cfg.ambienceVolume);
    this.speech?.setEnabled(cfg.speech);
    if (cfg.ambience && this.micHolds === 0) void this.ambience?.start();
    else this.ambience?.stop();
  }

  /** Mute the whole floor — used for the entire realtime coordinator session. */
  setMuted(muted: boolean): void {
    this.speech?.setMuted(muted);
  }

  setActivity(n: number): void {
    this.ambience?.setActivity(n);
  }

  trigger(kind: AmbienceEvent): void {
    this.ambience?.trigger(kind);
  }

  /** Ask an agent to say a line. Returns its utterance id, or null if refused. */
  speak(opts: SpeakOptions): string | null {
    return this.speech?.speak(opts) ?? null;
  }

  cancelConversation(conversationId: string): void {
    this.speech?.cancelConversation(conversationId);
  }

  cancelAgent(agentId: string): void {
    this.speech?.cancelAgent(agentId);
  }

  /** Await this BEFORE getUserMedia, always. Speech and ambience are faded out
   *  within 100 ms, pending chatter is dropped, and the promise resolves only
   *  once the floor is actually silent. */
  async silenceForMic(): Promise<void> {
    this.micHolds++;
    this.ambience?.fadeStop(MIC_FADE_MS);
    await this.speech?.silence(MIC_FADE_MS);
  }

  /** The microphone is closed. Nothing that was dropped comes back. */
  resumeAfterMic(): void {
    this.micHolds = Math.max(0, this.micHolds - 1);
    this.speech?.release();
    if (this.micHolds > 0) return;
    this.mixer?.setAmbienceVolume(this.config.ambienceVolume);
    if (this.config.ambience) void this.ambience?.start();
  }
}

export const officeAudio = new OfficeAudio();
```

- [ ] **Step 7: Delete the superseded queue**

```bash
git rm src/renderer/src/audio/speechQueue.ts test/tts-speech-queue.test.cjs
```

- [ ] **Step 8: Fix the one remaining caller**

`src/renderer/src/scene/office/Character.ts:366` calls `officeAudio.speak({ ..., onDuration })`.
`onDuration` no longer exists; Task 9 rewrites this method properly. For now rename the
option so the build stays green:

```ts
        onStart: (ms) => this.holdThought(ms)
```

- [ ] **Step 9: Typecheck and run the whole suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run test:focused`
Expected: PASS. The suite no longer contains `tts-speech-queue`.

- [ ] **Step 10: Commit**

```bash
git add -A src/renderer/src/audio src/renderer/src/scene/office/Character.ts test/tts-office-speech.test.cjs
git commit -m "feat(audio): wire the speech director in and make the microphone win"
```

---
### Task 7: Original banter and safe work-event reactions

The current pool is largely recognizable dialogue from *The Office*. It gets rewritten as
original workplace sitcom material, and a second pool is added for work events — built only
from the SHAPE of an event, never its content.

**Files:**
- Modify: `src/renderer/src/scene/office/cafeteriaLines.ts` (line pools rewritten; the
  exported functions keep their signatures)
- Create: `src/renderer/src/audio/reactionLines.ts`
- Test: `test/chatter-lines.test.cjs` (create)
- Test: `test/reaction-lines.test.cjs` (create)

**Interfaces:**
- Consumes: `isSpeakable`, `MAX_SPOKEN_CHARS` (Task 2) — used by the tests, not the pools.
- Produces:
  - `cafeteriaLines.ts` keeps `type BreakSpot`, `pickSoloLine(character, spot, seed, godName): string`,
    `pickExchange(speaker, seed, godName): readonly string[]`, and newly exports
    `ALL_RAW_LINES: readonly string[]` (every line in every pool, `{god}` unsubstituted) for
    the canary test.
  - `reactionLines.ts` exports `type MessageAct = 'assigned' | 'replied' | 'completed' | 'failed' | 'nudged'`,
    `type CoarseStatus = 'idle' | 'busy' | 'done' | 'error'`,
    `type PartyRole = 'coordinator' | 'teammate' | 'self'`,
    `interface WorkEvent { act: MessageAct; from: PartyRole; to: PartyRole; status: CoarseStatus; seed: number }`,
    `reactionFor(event: WorkEvent, godName: string): string | null`,
    `ALL_RAW_REACTIONS: readonly string[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/chatter-lines.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ALL_RAW_LINES, pickSoloLine, pickExchange } =
  loadTs('src/renderer/src/scene/office/cafeteriaLines.ts');
const { isSpeakable } = loadTs('src/renderer/src/audio/speechIntent.ts');

/** Phrases that would mean we shipped someone else's script. Matched
 *  case-insensitively against every line in every pool. */
const BORROWED = [
  "that's what she said", 'thats what she said', 'bears', 'beets',
  'battlestar', 'identity theft', 'declare bankruptcy', "world's best boss",
  'worlds best boss', 'dunder', 'mifflin', 'schrute', 'cornell', 'big tuna',
  'pretzel day', 'why waste time say lot word', 'bob vance', 'vance refrigeration',
  'did i stutter', 'three-hole-punch', 'i am beyonce always', 'stitious',
  'i started the fire', 'mung beans', 'the fire guy', 'jello'
];

test('no pool line is borrowed material', () => {
  for (const line of ALL_RAW_LINES) {
    const lower = line.toLowerCase();
    for (const phrase of BORROWED) {
      assert.equal(lower.includes(phrase), false, `borrowed phrase "${phrase}" in: ${line}`);
    }
  }
});

test('every pool line is short enough to speak and to fit the cloud', () => {
  for (const line of ALL_RAW_LINES) {
    assert.ok(line.length <= 60, `too long (${line.length}): ${line}`);
  }
});

test('every pool line passes the privacy guard once the boss name is substituted', () => {
  for (const line of ALL_RAW_LINES) {
    const spoken = line.split('{god}').join('Mark');
    assert.equal(isSpeakable(spoken), true, `guard refused a banter line: ${spoken}`);
  }
});

test('the boss token is replaced with the live coordinator name', () => {
  let sawToken = false;
  for (let seed = 0; seed < 400; seed++) {
    const solo = pickSoloLine('michael', 'table', seed, 'Mark');
    assert.equal(solo.includes('{god}'), false);
    if (solo.includes('Mark')) sawToken = true;
    for (const beat of pickExchange('jim', seed, 'Mark')) {
      assert.equal(beat.includes('{god}'), false);
    }
  }
  assert.equal(sawToken, true, 'at least one line should name the boss');
});

test('an exchange is at least two alternating beats', () => {
  for (let seed = 0; seed < 200; seed++) {
    const beats = pickExchange('jim', seed, 'Mark');
    assert.ok(beats.length >= 2, `seed ${seed} produced ${beats.length} beats`);
    assert.ok(beats.length <= 6, 'six beats is the per-conversation bound');
  }
});
```

Create `test/reaction-lines.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { reactionFor, ALL_RAW_REACTIONS } = loadTs('src/renderer/src/audio/reactionLines.ts');
const { isSpeakable } = loadTs('src/renderer/src/audio/speechIntent.ts');

const ACTS = ['assigned', 'replied', 'completed', 'failed', 'nudged'];
const ROLES = ['coordinator', 'teammate', 'self'];
const STATUSES = ['idle', 'busy', 'done', 'error'];

test('every reaction line is speakable, short, and original', () => {
  for (const line of ALL_RAW_REACTIONS) {
    assert.ok(line.length <= 60, `too long: ${line}`);
    assert.equal(isSpeakable(line.split('{god}').join('Mark')), true, `refused: ${line}`);
  }
});

// The privacy canary. reactionFor cannot leak work data because it is never
// given any: its whole input is an act, two roles, a status bucket and a seed.
// This sweeps the entire input space and proves every output came from the pool.
test('a reaction can only ever be a line from the pool', () => {
  const allowed = new Set(ALL_RAW_REACTIONS.map((l) => l.split('{god}').join('Mark')));
  for (const act of ACTS) {
    for (const from of ROLES) {
      for (const to of ROLES) {
        for (const status of STATUSES) {
          for (let seed = 0; seed < 50; seed++) {
            const line = reactionFor({ act, from, to, status, seed }, 'Mark');
            if (line === null) continue;
            assert.equal(allowed.has(line), true, `off-pool output: ${line}`);
          }
        }
      }
    }
  }
});

test('the same event shape always produces the same line', () => {
  const event = { act: 'completed', from: 'self', to: 'coordinator', status: 'done', seed: 7 };
  assert.equal(reactionFor(event, 'Mark'), reactionFor(event, 'Mark'));
});

test('most events stay silent', () => {
  let spoken = 0;
  let total = 0;
  for (const act of ACTS) {
    for (let seed = 0; seed < 100; seed++) {
      total++;
      if (reactionFor({ act, from: 'teammate', to: 'self', status: 'busy', seed }, 'Mark')) spoken++;
    }
  }
  assert.ok(spoken / total < 0.5, `too chatty: ${spoken}/${total} events spoke`);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/chatter-lines.test.cjs test/reaction-lines.test.cjs`
Expected: FAIL — `ALL_RAW_LINES` is undefined, `reactionLines.ts` does not exist, and the
borrowed-material check fails against the current pools.

- [ ] **Step 3: Rewrite the cafeteria pools**

In `src/renderer/src/scene/office/cafeteriaLines.ts`, replace the header comment and every
pool. `pick`, `withGod`, `pickSoloLine` and `pickExchange` keep their existing bodies except
where noted; `SPOT_POOL`, `PAIR_POOL` and `KEYED_EXCHANGES` keep their existing shapes.

Header:

```ts
// Cafeteria small-talk.
//
// An agent's coffee break is an excuse for a one-liner. Two kinds of line:
//   • solo  — one quip shown above a single agent at a break spot
//   • pair  — a multi-beat exchange between two agents at the same table
//
// The material is ORIGINAL. The sprites are drawn from a borrowed cast, but the
// words are ours: no quotations, no catchphrases, nothing anyone else wrote.
// Lines stay under 60 characters so they fit the ThoughtBubble and are short
// enough to speak. Character keys match OfficeCharacterName; anyone without
// bespoke lines falls back to the shared pools so the floor never feels empty.
//
// House rules for anything added here: workplace-flavoured, a bit dry, adult
// humour allowed. No slurs, no jokes keyed to protected traits, no targeted
// gossip about a named coworker, nothing explicit, and nobody claims to be a
// real person.
```

Solo pools:

```ts
const COFFEE: readonly string[] = [
  'this is decaf. someone has declared war.',
  'we are out of beans. again.',
  'first cup of the day. also the fifth.',
  'the mug says world class. the mug is lying.',
  'who moved my mug',
  'coffee first. opinions after.'
];

const VENDING: readonly string[] = [
  'the machine ate my dollar',
  'B4. please be the pretzels.',
  'it is stuck. of course it is stuck.',
  'shaking it. gently. respectfully.',
  'one emotional support snack, please',
  'A1 again. living dangerously.'
];

const SNACK: readonly string[] = [
  'is it snack o clock',
  'who finished the chips',
  'just a little treat',
  'these were communal? news to me.',
  'second breakfast. no regrets.'
];

const TABLE: readonly string[] = [
  'big day. many meetings. zero progress.',
  'five more minutes and I am a new person',
  'did you read the standup notes',
  'pretending to read my notes',
  'I needed this, honestly',
  'do not tell {god} I am in here'
];
```

Character flavour:

```ts
const BY_CHARACTER: Partial<Record<OfficeCharacterName, readonly string[]>> = {
  michael:  ['I am the fun one. it is documented.', 'I read the whole memo. the title of it.', 'no meetings before coffee. house rule.', 'leadership is mostly snacks'],
  dwight:   ['incorrect.', 'this mug is regulation issue', 'the fridge needs a lock and a log', 'my farm has better coffee than this'],
  jim:      ['I moved his stapler two inches. patience.', 'just here for the gossip', 'nobody has noticed yet. give it a week.'],
  pam:      ['front desk, all day, every day', 'sketching the vending machine again', 'this break room deserves better art'],
  kevin:    ['fewer words. more snack.', 'snack now. talk later.', 'cookie? cookie.'],
  angela:   ['this break room is a health hazard', 'party planning, three o clock, be early', 'I am judging the fridge and it knows'],
  oscar:    ['well, technically—', 'the snack budget is out of control', 'someone should audit that machine'],
  stanley:  ['crossword and coffee. leave me be.', 'I will retire before this brews', 'do not talk to me until Friday'],
  phyllis:  ['getting picked up at five', 'knitting and a nice cup of tea'],
  andy:     ['great story about my old school—', 'coffee break! everybody!', 'big guy. grab a chair.'],
  kelly:    ['okay you did not hear this from me', 'so much to tell you. so much.', 'I know everything and I am telling you'],
  ryan:     ['I have three ideas and a deck', 'the temp needs caffeine', 'I could disrupt this break room'],
  toby:     ['I should probably write that up', 'nobody ever sits with me', 'HR wise, this break is fine'],
  creed:    ['which one are you again', 'I have eaten worse out of that fridge', 'I keep beans under my desk. not coffee.'],
  meredith: ['is it five o clock yet', 'somebody spike this coffee']
};
```

Exchanges — replace both `EXCHANGES` and `TWSS_EXCHANGES` with a single original pool, and
delete the `TWSS_EXCHANGES` constant and its comment block entirely:

```ts
// Generic banter — works between any two agents. Beats alternate: index 0 is the
// speaker who sat down, index 1 their table-mate, and so on. Six beats maximum,
// which is also the director's per-conversation bound.
const EXCHANGES: readonly Exchange[] = [
  ['is the build green', 'do not look at it', 'I looked.'],
  ['standup ran forty minutes', 'could have been an email', 'it WAS an email'],
  ['who replied all', 'we do not speak of it'],
  ['I have three tabs open', 'I have three hundred', 'that is a cry for help'],
  ['guess who broke it', 'you', 'guess again', 'still you'],
  ['do you ever just stare at the ceiling', 'constantly', 'good. me too.'],
  ['I renamed the file', 'to what', 'final final two', 'perfect.'],
  ['is a wrap a sandwich', 'it is', 'thank you. vindicated.'],
  ['I lowered his chair two inches', 'he will never know', 'he will FEEL it'],
  ['what do we actually do here', 'paperwork', 'right. love that for us.'],
  ['I have not blinked since ten', 'blink now', '...better'],
  ['my review said see me', 'that is never good', 'it is never good'],
  ['I told {god} it was done', 'was it done', 'it is now', 'that is the spirit'],
  ['I have a system', 'you have a pile', 'the pile IS the system'],
  ['are you okay', 'define okay', 'that is a no', 'that is a no'],
  ['I love my cat more than most people', 'including me', 'especially you'],
  ['did you just sigh at me', 'I sighed near you', 'that is worse'],
  ['stop reading my screen', 'stop having an interesting screen'],
  ['sign this', 'what is it', 'better you do not know', '...fine'],
  ['I fixed it', 'how', 'I turned it off and on', 'genius'],
  ['that meeting could have been a nap', 'every meeting could be a nap'],
  ['I have been on hold an hour', 'with who', 'I forget. I am invested now.'],
  ['why is the printer angry', 'it has always been angry', 'fair'],
  ['I brought snacks', 'you are my favourite', 'I know. that is why.'],
  ['new keyboard day', 'let me hear it', 'clack. clack.', 'beautiful'],
  ['I apologised to the coffee machine', 'why', 'twice, actually'],
  ['do you think {god} noticed', 'no', 'did anyone notice', 'also no'],
  ['I dreamed about the spreadsheet', 'was it green', 'it was red', 'I am so sorry'],
  ['I said I was fine in the standup', 'were you fine', 'I lied beautifully'],
  ['two hours of my life, gone', 'where', 'a dropdown menu'],
  ['I labelled everything', 'and', 'now I cannot find anything'],
  ['my chair squeaks in the key of D', 'that is very specific', 'I have had time']
];

// Everything any table-mate pair can draw from.
const PAIR_POOL: readonly Exchange[] = EXCHANGES;
```

Keyed openers:

```ts
// Keyed off the SPEAKER so, when the right character sits down first, they get
// to open with the bit that suits them.
const KEYED_EXCHANGES: Partial<Record<OfficeCharacterName, Exchange>> = {
  michael:  ['team meeting. five minutes. bring energy.', 'bring what', 'energy. and snacks.'],
  dwight:   ['this fridge needs a lock and a log', 'it is a fridge', 'it is a liability'],
  kevin:    ['fewer words. more snack.', 'that is not fewer words', 'snack.'],
  kelly:    ['okay do not freak out', 'I am already freaking out', 'good, keeps us even'],
  oscar:    ['well, technically—', 'here we go', 'you will thank me'],
  angela:   ['this table is filthy', 'it is a break room', 'that is not a defence'],
  creed:    ['which one are you again', 'we sit next to each other', 'sure we do'],
  stanley:  ['is it Friday', 'it is Tuesday', 'then we have nothing to discuss'],
  andy:     ['great story about my old school—', 'nobody asked', 'so, my old school—'],
  jim:      ['question', 'yes', 'nothing. checking you were awake.'],
  pam:      ['I drew you', 'is it flattering', 'it is accurate', 'oh no'],
  ryan:     ['I have a deck about this break room', 'of course you do'],
  toby:     ['can I sit here', 'sure', '...thank you', 'you did not have to ask'],
  phyllis:  ['tea?', 'always', 'good answer'],
  meredith: ['is it five', 'it is ten thirty', 'close enough']
};
```

Finally, export the raw pools for the canary, at the bottom of the file:

```ts
/** Every line in every pool, `{god}` unsubstituted. Exists so the test suite can
 *  prove the whole corpus is original, short and speakable — not for runtime use. */
export const ALL_RAW_LINES: readonly string[] = [
  ...COFFEE, ...VENDING, ...SNACK, ...TABLE,
  ...Object.values(BY_CHARACTER).flatMap((lines) => (lines ? [...lines] : [])),
  ...PAIR_POOL.flat(),
  ...Object.values(KEYED_EXCHANGES).flatMap((beats) => (beats ? [...beats] : []))
];
```

- [ ] **Step 4: Write the reaction pool**

Create `src/renderer/src/audio/reactionLines.ts`:

```ts
// What an agent says ABOUT work, without ever being told what the work is.
//
// This is the privacy boundary of the whole feature. A reaction is generated
// from four things: which act happened, the ROLE of who sent it, the role of who
// received it, and a coarse status bucket. No prompt, no task text, no message
// subject or body, no terminal output, no filename, no path, no memory, no
// webhook or Slack content is a parameter here, so none of it can be spoken.
// Sender and recipient arrive as roles rather than names because agent names are
// user data too, and a role is enough to write a line.
//
// Most events return null on purpose. A floor that comments on everything is
// exhausting; the director's 12s reaction cooldown is the second line of defence,
// not the first.

export type MessageAct = 'assigned' | 'replied' | 'completed' | 'failed' | 'nudged';
export type CoarseStatus = 'idle' | 'busy' | 'done' | 'error';
export type PartyRole = 'coordinator' | 'teammate' | 'self';

export interface WorkEvent {
  act: MessageAct;
  from: PartyRole;
  to: PartyRole;
  status: CoarseStatus;
  /** Deterministic pick — the same event shape always says the same thing. */
  seed: number;
}

const ASSIGNED: readonly string[] = [
  'new one. cracking knuckles.',
  'another one. love that for me.',
  'on it. mostly.',
  'sure. add it to the pile.'
];

const FROM_COORDINATOR: readonly string[] = [
  '{god} wants a word',
  'message from upstairs',
  'yes {god}. on it.'
];

const COMPLETED: readonly string[] = [
  'done. and it works.',
  'shipped it',
  'that one fought back',
  'clean. no notes.'
];

const FAILED: readonly string[] = [
  'well that went badly',
  'okay. plan B.',
  'that is going in the report',
  'not my finest hour'
];

const REPLIED: readonly string[] = [
  'someone answered me',
  'good. I was starting to worry.'
];

const NUDGED: readonly string[] = [
  'I am awake. I am awake.',
  'yes. moving.'
];

/** Every line above, for the privacy canary. Not for runtime use. */
export const ALL_RAW_REACTIONS: readonly string[] = [
  ...ASSIGNED, ...FROM_COORDINATOR, ...COMPLETED, ...FAILED, ...REPLIED, ...NUDGED
];

const pick = (pool: readonly string[], seed: number): string =>
  pool[((seed % pool.length) + pool.length) % pool.length];

const withGod = (line: string, godName: string): string => line.split('{god}').join(godName);

/** A line for this event, or null when the floor should stay quiet. */
export function reactionFor(event: WorkEvent, godName: string): string | null {
  // Roughly half of everything passes in silence. Deterministic, so the same
  // event never sometimes speaks and sometimes does not.
  if (event.seed % 2 === 0) return null;

  if (event.from === 'coordinator' && event.act !== 'completed') {
    return withGod(pick(FROM_COORDINATOR, event.seed), godName);
  }

  switch (event.act) {
    case 'assigned':  return withGod(pick(ASSIGNED, event.seed), godName);
    case 'completed': return event.status === 'error'
      ? withGod(pick(FAILED, event.seed), godName)
      : withGod(pick(COMPLETED, event.seed), godName);
    case 'failed':    return withGod(pick(FAILED, event.seed), godName);
    case 'replied':   return withGod(pick(REPLIED, event.seed), godName);
    case 'nudged':    return withGod(pick(NUDGED, event.seed), godName);
    default:          return null;
  }
}
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `node --test test/chatter-lines.test.cjs test/reaction-lines.test.cjs`
Expected: PASS, 9 tests.

- [ ] **Step 6: Typecheck and run the suite**

Run: `npm run typecheck && npm run test:focused`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/scene/office/cafeteriaLines.ts src/renderer/src/audio/reactionLines.ts test/chatter-lines.test.cjs test/reaction-lines.test.cjs
git commit -m "feat(office): original banter pool and shape-only work-event reactions"
```

---

### Task 8: Balanced cadence

How often the floor starts a conversation, and how often it may react to work. Pure, so the
numbers can be pinned without waiting 40 seconds per assertion.

**Files:**
- Create: `src/renderer/src/audio/chatterCadence.ts`
- Test: `test/chatter-cadence.test.cjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CADENCE = { socialMinMs: 20000, socialMaxMs: 40000, reactionCooldownMs: 12000 }`
  - `class ChatterCadence` with `constructor(random: () => number)`, `arm(now: number): void`,
    `shouldStartExchange(now: number, availablePairs: number): boolean`,
    `noteExchangeStarted(now: number): void`, `allowReaction(now: number): boolean`,
    `noteReaction(now: number): void`

- [ ] **Step 1: Write the failing test**

Create `test/chatter-cadence.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ChatterCadence, CADENCE } = loadTs('src/renderer/src/audio/chatterCadence.ts');

test('the shipped cadence is one exchange every 20 to 40 seconds', () => {
  assert.equal(CADENCE.socialMinMs, 20000);
  assert.equal(CADENCE.socialMaxMs, 40000);
  assert.equal(CADENCE.reactionCooldownMs, 12000);
});

test('an exchange is due only after the interval, and only with a pair to talk', () => {
  const c = new ChatterCadence(() => 0);       // shortest interval: 20s
  c.arm(1000);
  assert.equal(c.shouldStartExchange(1000, 2), false);
  assert.equal(c.shouldStartExchange(20999, 2), false);
  assert.equal(c.shouldStartExchange(21000, 0), false, 'nobody to talk to');
  assert.equal(c.shouldStartExchange(21000, 1), true);
});

test('the interval is re-rolled inside the window after each exchange', () => {
  const c = new ChatterCadence(() => 1);       // longest interval: 40s
  c.arm(0);
  c.noteExchangeStarted(1000);
  assert.equal(c.shouldStartExchange(40999, 3), false);
  assert.equal(c.shouldStartExchange(41000, 3), true);
});

test('reactions hold a 12 second global cooldown', () => {
  const c = new ChatterCadence(() => 0.5);
  assert.equal(c.allowReaction(1000), true, 'the first reaction is free');
  c.noteReaction(1000);
  assert.equal(c.allowReaction(12999), false);
  assert.equal(c.allowReaction(13000), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/chatter-cadence.test.cjs`
Expected: FAIL — `Cannot find module .../chatterCadence.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/audio/chatterCadence.ts`:

```ts
// How chatty the floor is.
//
// "Balanced" is a fixed behaviour, not a setting: roughly one social exchange
// every 20-40 seconds when there are agents free to have one, and at most one
// work-event reaction every 12 seconds across the whole floor. Both numbers live
// here rather than in OfficeFloor.tsx so they can be tested without a clock.
//
// This decides WHEN a conversation may begin. The speech director decides who
// speaks and when each beat lands; the two are deliberately separate.

export const CADENCE = {
  socialMinMs: 20000,
  socialMaxMs: 40000,
  reactionCooldownMs: 12000
} as const;

export class ChatterCadence {
  private nextExchangeAt = 0;
  private lastReactionAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly random: () => number) {}

  /** Start the clock. Call once when the floor mounts. */
  arm(now: number): void {
    this.nextExchangeAt = now + this.interval();
  }

  /** True when a new exchange is due and there is somebody to have it with. */
  shouldStartExchange(now: number, availablePairs: number): boolean {
    if (availablePairs < 1) return false;
    return now >= this.nextExchangeAt;
  }

  noteExchangeStarted(now: number): void {
    this.nextExchangeAt = now + this.interval();
  }

  allowReaction(now: number): boolean {
    return now - this.lastReactionAt >= CADENCE.reactionCooldownMs;
  }

  noteReaction(now: number): void {
    this.lastReactionAt = now;
  }

  private interval(): number {
    const span = CADENCE.socialMaxMs - CADENCE.socialMinMs;
    return CADENCE.socialMinMs + Math.floor(this.random() * span);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/chatter-cadence.test.cjs`
Expected: PASS, 4 tests.

Note: the third case relies on `Math.floor(1 * 20000) === 20000`, so `interval()` returns
exactly 40000 for `random: () => 1`. Keep the `Math.floor`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/audio/chatterCadence.ts test/chatter-cadence.test.cjs
git commit -m "feat(office): balanced chatter cadence with a reaction cooldown"
```

---

### Task 9: Scene wiring — visual-only bubbles, spoken captions, cancellation

The last of the four original problems: thought bubbles currently speak everything, and the
cafeteria director plays exchanges on a 2.4 second visual beat that has nothing to do with
the audio. Both are fixed here.

**Files:**
- Modify: `src/renderer/src/scene/office/Character.ts` (`showThought`, new `say`, new
  `stereoPan`, caption state; remove `lastSpokenThought`)
- Modify: `src/renderer/src/scene/office/OfficeFloor.tsx` (`CafeChat` shape, `maybePairChat`,
  `emitQuip`, the `updateCafeteria` beat loop, `releaseBreak`, work-event reactions, unmount)
- Test: `test/office-chatter-wiring.test.cjs` (create)

`OfficeFloor.tsx` and `Character.ts` import Pixi and cannot be loaded by `test/load-ts.cjs`,
so their contract is pinned by source-shape assertions in the same style as
`test/audio-config.test.cjs`. That is weaker than a behavioural test and is why all the
policy lives in the pure modules that Tasks 3, 4, 7 and 8 do cover.

**Interfaces:**
- Consumes: `officeAudio.speak/cancelConversation/cancelAgent` (Task 6), `pickSoloLine` /
  `pickExchange` (Task 7), `ChatterCadence` (Task 8), `reactionFor` (Task 7).
- Produces:
  - `Character.say(opts: { text: string; priority?: SpeechPriority; conversationId?: string; beatIndex?: number; ttlMs?: number; onEnd?: () => void }): string | null`
  - `Character.showThought(text: string, tool?: string): void` — visual only
  - `Character.silence(): void` — cancels this agent's pending and live speech

- [ ] **Step 1: Write the failing test**

Create `test/office-chatter-wiring.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('showThought is visual only — it must never speak', () => {
  const src = read('src/renderer/src/scene/office/Character.ts');
  const body = src.slice(src.indexOf('showThought('), src.indexOf('holdThought('));
  assert.equal(/officeAudio\.speak/.test(body), false,
    'live work status must not be read aloud');
});

test('say() captions on real playback start and restores the work bubble', () => {
  const src = read('src/renderer/src/scene/office/Character.ts');
  assert.match(src, /say\(opts:/);
  assert.match(src, /onStart:/);
  assert.match(src, /onEnd:/);
  assert.match(src, /pan: this\.stereoPan\(\)/);
});

test('the cafeteria no longer runs conversations on a fixed visual beat', () => {
  const src = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.equal(/beat = 2\.4/.test(src), false, 'audio completion drives the beats now');
  assert.equal(/seconds per line/.test(src), false);
});

test('leaving, resuming or unmounting cancels that agent’s speech', () => {
  const src = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(src, /officeAudio\.cancelConversation\(/);
  assert.match(src, /officeAudio\.cancelAgent\(/);
});

test('the floor uses the balanced cadence rather than ad-hoc random rolls', () => {
  const src = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(src, /ChatterCadence/);
  assert.equal(/Math\.random\(\) < 0\.004/.test(src), false, 'replaced by the cadence');
});

test('work-event reactions go through the shape-only builder', () => {
  const src = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(src, /reactionFor\(/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/office-chatter-wiring.test.cjs`
Expected: FAIL on all six.

- [ ] **Step 3: Make thought bubbles visual-only and add `say()`**

In `src/renderer/src/scene/office/Character.ts`, delete the `lastSpokenThought` field
(line 119) and replace `showThought`/`holdThought` (lines ~354-382) with:

```ts
  /** Show what the agent is doing right now in the thought cloud above its head.
   *  Empty text renders an animated "…" (thinking); `tool` adds a small glyph.
   *
   *  VISUAL ONLY. This used to also speak, which meant live work status — file
   *  names, commands, tool output — was read aloud and handed to the synthesizer.
   *  Speech is now an explicit request via say(), whose text comes from a banter
   *  pool. While a spoken caption is up, the work status is remembered and
   *  restored the moment the audio ends. */
  showThought(text: string, tool?: string): void {
    this.workThought = { text, tool };
    if (this.captionActive) return;      // a spoken line owns the cloud right now
    this.thoughtBubble.show(text, tool);
  }

  /** Say a line aloud. The caption appears when the audio actually STARTS (not
   *  when it is queued) and holds for the clip's real length; the work-status
   *  cloud comes back when it ends. Returns the utterance id, or null if the
   *  floor refused the line — in which case the line is still SHOWN, so a silent
   *  office (speech off, mic open, no model) still looks alive. */
  say(opts: {
    text: string;
    priority?: SpeechPriority;
    conversationId?: string;
    beatIndex?: number;
    ttlMs?: number;
    onEnd?: () => void;
  }): string | null {
    const id = officeAudio.speak({
      agentId: this.agentId,
      character: this.characterName,
      isGod: this.isGod,
      text: opts.text,
      priority: opts.priority,
      conversationId: opts.conversationId,
      beatIndex: opts.beatIndex,
      ttlMs: opts.ttlMs,
      pan: this.stereoPan(),
      onStart: (ms) => {
        this.captionActive = true;
        this.thoughtBubble.show(opts.text);
        this.thoughtBubble.holdFor(ms);
      },
      onEnd: () => {
        this.captionActive = false;
        if (this.workThought) this.thoughtBubble.show(this.workThought.text, this.workThought.tool);
        else this.thoughtBubble.startLinger();
        opts.onEnd?.();
      }
    });
    if (id === null) {
      // Refused (speech off, mic open, no model, or a bounded queue). Show the
      // line anyway and let it fade on the usual timer — a silent office should
      // still read as a talking one.
      this.thoughtBubble.show(opts.text);
      this.thoughtBubble.startLinger();
    }
    return id;
  }

  /** Drop anything this agent has queued or is saying — it left, went back to
   *  work, or is being removed from the floor. */
  silence(): void {
    officeAudio.cancelAgent(this.agentId);
  }

  /** Where this agent sits in the stereo field, from its x across the map.
   *  Kept gentle (±0.6) so a line never sounds like it came from another room. */
  private stereoPan(): number {
    const worldW = this.mapRenderer.width * this.mapRenderer.tileSize;
    if (worldW <= 0) return 0;
    const normalized = (this.px / worldW) * 2 - 1;
    return Math.max(-1, Math.min(1, normalized)) * 0.6;
  }
```

Add the two fields next to the other private state (near line 119):

```ts
  /** The work status the cloud shows when nothing is being spoken. */
  private workThought: { text: string; tool?: string } | null = null;
  /** True while a spoken caption owns the cloud. */
  private captionActive = false;
```

Add the import alongside the existing `officeAudio` import at line 7:

```ts
import type { SpeechPriority } from '../../audio/speechIntent';
```

`holdThought(ms)` is now only called from `say()`'s `onStart`; inline it there (as above) and
delete the method.

- [ ] **Step 4: Drive cafeteria exchanges from audio completion**

In `src/renderer/src/scene/office/OfficeFloor.tsx`:

1. Extend the imports:

```ts
import { pickSoloLine, pickExchange, type BreakSpot } from './cafeteriaLines';
import { ChatterCadence } from '@/audio/chatterCadence';
import { reactionFor, type MessageAct, type PartyRole, type CoarseStatus } from '@/audio/reactionLines';
```

2. Replace the `CafeChat` interface (lines ~31-37) — there is no timer any more, because the
   director calls back when a beat is over:

```ts
/** A cafeteria conversation in progress. The director owns the timing: each beat
 *  is queued as a spoken intent and `idx` advances when that beat's audio ENDS,
 *  so the bubbles and the voices can never drift apart. */
interface CafeChat {
  lines: readonly string[];        // alternating beats: even = initiator, odd = partner
  partnerId: string;
  idx: number;                     // beat currently queued or speaking
  conversationId: string;
  /** True once every beat has been queued and the last one has ended. */
  finished: boolean;
}
```

3. Add the cadence next to the other director state (near `let cafeCooldown = 5;`):

```ts
      const cadence = new ChatterCadence(Math.random);
      cadence.arm(performance.now());
      let conversations = 0;
```

4. Replace `maybePairChat`'s tail so it queues the FIRST beat instead of setting a timer:

```ts
        const character = agentById(id)?.character ?? DEFAULT_CHARACTER;
        const bossName = resolveGodName(useStore.getState().agents.find((a) => a.isGod)?.name);
        const lines = pickExchange(character, Math.floor(Math.random() * 1e6), bossName);
        const conversationId = `cafe-${id}-${++conversations}`;
        rt.brk.chat = { lines, partnerId, idx: 0, conversationId, finished: false };
        prt.brk.chattingWith = id;
        speakBeat(rt, partnerId);
        cadence.noteExchangeStarted(performance.now());
        return true;
```

5. Add `speakBeat` just above `maybePairChat`. This is the whole beat engine now:

```ts
      // Queue one beat of a conversation. The NEXT beat is queued from this one's
      // onEnd, which fires on real audio completion — that is what keeps the two
      // sprites in sync with their own voices. A refused line (muted floor, mic
      // open, disabled speech) ends the conversation rather than hanging it.
      const speakBeat = (rt: Runtime, partnerId: string): void => {
        const chat = rt.brk?.chat;
        if (!chat || chat.finished) return;
        if (chat.idx >= chat.lines.length) {
          chat.finished = true;
          const prt = runtimes.get(partnerId);
          if (prt?.brk) prt.brk.chattingWith = undefined;
          rt.brk!.chat = undefined;
          return;
        }
        const speaker = chat.idx % 2 === 0 ? rt : runtimes.get(partnerId);
        const beatIndex = chat.idx;
        const accepted = speaker?.character.say({
          text: chat.lines[beatIndex],
          priority: 'conversation',
          conversationId: chat.conversationId,
          beatIndex,
          onEnd: () => {
            const live = rt.brk?.chat;
            if (!live || live.conversationId !== chat.conversationId) return; // cancelled
            live.idx = beatIndex + 1;
            speakBeat(rt, partnerId);
          }
        });
        if (!accepted) {
          chat.finished = true;
          const prt = runtimes.get(partnerId);
          if (prt?.brk) prt.brk.chattingWith = undefined;
          if (rt.brk) rt.brk.chat = undefined;
          return;
        }
        // Keep both agents at the table long enough to finish the exchange.
        rt.brk!.timer = Math.max(rt.brk!.timer, 4);
        const prt = runtimes.get(partnerId);
        if (prt?.brk) prt.brk.timer = Math.max(prt.brk.timer, 4);
      };
```

6. Replace the beat loop inside `updateCafeteria` (the `if (b.chat) { … }` block, lines
   ~781-806) with:

```ts
          if (b.chat) {
            // Nothing to do per frame: the director advances the conversation from
            // each beat's audio completion. Just hold both agents in place.
            b.timer = Math.max(b.timer, 1);
          } else if (!b.chattingWith) {
```

7. In the same `else if (!b.chattingWith)` branch, replace the ad-hoc pair roll with the
   cadence:

```ts
            b.quipTimer -= dt;
            if (b.quipTimer <= 0) {
              b.quipTimer = 4 + Math.random() * 4;
              emitQuip(id, rt, b.spotIdx);
            } else if (cadence.shouldStartExchange(performance.now(), 1)) {
              maybePairChat(id, rt, b.spotIdx);
            }
```

8. Make `emitQuip` speak rather than only draw. Replace its two `showThought` calls:

```ts
        if (godDistance(p.x, p.y) > 96 && Math.random() < 0.35) {
          const gossip = t(GOSSIP_KEYS[Math.floor(Math.random() * GOSSIP_KEYS.length)]);
          rt.character.say({ text: gossip, priority: 'ambient' });
          return;
        }
        // The boss's live name, not the borrowed cast's — see cafeteriaLines.withGod().
        const bossName = resolveGodName(useStore.getState().agents.find((a) => a.isGod)?.name);
        rt.character.say({ text: pickSoloLine(character, spot.spot, seed, bossName), priority: 'ambient' });
```

   `say()` draws the line whether or not it is spoken, so no separate `showThought` call is
   needed here. The gossip strings come from `t()` rather than a banter pool; `isSpeakable`
   refuses anything path- or code-shaped that a translation might contain, and the line is
   then shown but not voiced — which is the correct outcome, not a bug to work around.

9. Cancel speech wherever a conversation can be torn down. In `releaseBreak`, at the top:

```ts
      const releaseBreak = (rt: Runtime): void => {
        if (!rt.brk) return;
        if (rt.brk.chat) {
          // The agent is leaving mid-sentence: drop every remaining beat rather
          // than letting a disembodied reply play over an empty table.
          officeAudio.cancelConversation(rt.brk.chat.conversationId);
          const p = runtimes.get(rt.brk.chat.partnerId);
          if (p?.brk) p.brk.chattingWith = undefined;
        }
```

10. When an agent goes back to work or is removed, silence it. In the status-transition
    block near line 1494 (`wasBusy` / `isBusy`), add:

```ts
        if (!wasBusy && isBusy) rt.character.silence();
```

    and wherever a runtime is deleted from `runtimes` on despawn or unmount, add
    `officeAudio.cancelAgent(id);` before the delete.

11. Work-event reactions. In the same status-transition block, after the cheer decision:

```ts
        // A reaction is built from the SHAPE of the event only — act, roles and a
        // coarse status. No task text, no message body, no output ever reaches it.
        if (wasBusy && !isBusy && cadence.allowReaction(performance.now())) {
          const act: MessageAct = agent.status === 'error' ? 'failed' : 'completed';
          const from: PartyRole = 'self';
          const to: PartyRole = 'coordinator';
          const status: CoarseStatus = agent.status === 'error' ? 'error' : 'done';
          const bossName = resolveGodName(useStore.getState().agents.find((a) => a.isGod)?.name);
          const line = reactionFor({ act, from, to, status, seed: Math.floor(Math.random() * 1e6) }, bossName);
          if (line && rt.character.say({ text: line, priority: 'reaction', ttlMs: 4000 })) {
            cadence.noteReaction(performance.now());
          }
        }
```

- [ ] **Step 5: Run the wiring test to verify it passes**

Run: `node --test test/office-chatter-wiring.test.cjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck and run the suite**

Run: `npm run typecheck`
Expected: PASS. If `agent.status === 'error'` is not a valid status in this codebase, use the
error status name that `Agent` actually declares — the surrounding code at line ~1499 lists
the busy ones.

Run: `npm run test:focused`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/scene/office/Character.ts src/renderer/src/scene/office/OfficeFloor.tsx test/office-chatter-wiring.test.cjs
git commit -m "feat(office): audio-synced conversations, visual-only status bubbles"
```

---

### Task 10: The microphone always wins

Floor speech is muted when the realtime status changes, but the mute is never awaited before
the mic opens, and Free Flow does not mute at all. Both call sites now wait for confirmed
silence.

**Files:**
- Modify: `src/renderer/src/realtime/session.ts` (`connect()` and its teardown)
- Modify: `src/renderer/src/freeflow/recorder.ts` (`start()` and its teardown)
- Test: `test/mic-silence.test.cjs` (create)

**Interfaces:**
- Consumes: `officeAudio.silenceForMic()` / `resumeAfterMic()` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `test/mic-silence.test.cjs`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MIC_SITES = [
  'src/renderer/src/realtime/session.ts',
  'src/renderer/src/freeflow/recorder.ts'
];

test('every mic call site awaits confirmed floor silence before capturing', () => {
  for (const rel of MIC_SITES) {
    const src = read(rel);
    const silence = src.indexOf('await officeAudio.silenceForMic()');
    const capture = src.indexOf('getUserMedia({');
    assert.ok(silence >= 0, `${rel} never silences the floor`);
    assert.ok(capture >= 0, `${rel} has no getUserMedia call to guard`);
    assert.ok(silence < capture,
      `${rel} opens the mic before the floor is silent`);
  }
});

test('every mic call site releases the floor again when it is done', () => {
  for (const rel of MIC_SITES) {
    assert.match(read(rel), /officeAudio\.resumeAfterMic\(\)/,
      `${rel} leaves the floor permanently silent`);
  }
});

test('the fade budget is 100ms', () => {
  const src = read('src/renderer/src/audio/officeSpeech.ts');
  assert.match(src, /MIC_FADE_MS = 100/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mic-silence.test.cjs`
Expected: FAIL — neither file mentions `silenceForMic`.

- [ ] **Step 3: Guard the realtime session**

In `src/renderer/src/realtime/session.ts`, add the import at the top:

```ts
import { officeAudio } from '@/audio';
```

In `connect()`, immediately after `await setMicGate(true);` and BEFORE `getUserMedia`:

```ts
    // Silence the office floor and WAIT for it. Muting on the status change was
    // not enough: a line already playing would be picked up by the open mic and
    // transcribed as if the user had said it.
    await officeAudio.silenceForMic();
```

In the teardown path — wherever `setMicGate(false)` is called on disconnect and on the error
path in `connect()`'s `catch` — add alongside it:

```ts
    officeAudio.resumeAfterMic();
```

- [ ] **Step 4: Guard Free Flow**

In `src/renderer/src/freeflow/recorder.ts`, add the import:

```ts
import { officeAudio } from '@/audio';
```

In `start()`, replace the `getUserMedia` block's opening so the silence is awaited first:

```ts
  wantActive = true;
  opening = true;
  setState({ error: null });
  // Push-to-talk is short, but the floor still has to be quiet before the mic
  // opens or a quip lands in the middle of the user's dictation.
  await officeAudio.silenceForMic();
  let opened: MediaStream;
  try {
    opened = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    opening = false;
    wantActive = false;
    officeAudio.resumeAfterMic();
```

Add `officeAudio.resumeAfterMic();` to the other two exits from a capture: the
`if (!wantActive)` discard branch inside `start()`, and `teardownStream()` (or whichever
function stops the tracks at the end of a recording) — so every path that opened the floor's
silence also closes it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/mic-silence.test.cjs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck and run the suite**

Run: `npm run typecheck && npm run test:focused`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/realtime/session.ts src/renderer/src/freeflow/recorder.ts test/mic-silence.test.cjs
git commit -m "fix(audio): await confirmed floor silence before either mic opens"
```

---

### Task 11: Verification, attribution and handoff

**Files:**
- Modify: `src/renderer/src/assets/ATTRIBUTION.md` (confirm the Kokoro and ambience entries)
- Create: `C:\Obs\Mark\Web work\office-agent\office-agent.md` (append if it exists)

**Interfaces:**
- Consumes: everything.
- Produces: the record of what shipped.

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck`
Expected: PASS, both projects.

Run: `npm run test:focused`
Expected: PASS. New suites present: `tts-mixer`, `tts-speech-intent`, `tts-speech-director`,
`tts-director-policy`, `tts-engine-recovery`, `tts-office-speech`, `chatter-lines`,
`reaction-lines`, `chatter-cadence`, `office-chatter-wiring`, `mic-silence`. Removed:
`tts-speech-queue`.

- [ ] **Step 2: Check attribution before any packaging**

Run: `node -e "const s=require('fs').readFileSync('src/renderer/src/assets/ATTRIBUTION.md','utf8'); console.log(/Kokoro/i.test(s), /LimeZu/i.test(s))"`
Expected: `true true`. If the Kokoro line is missing, add:

```markdown
- Speech: Kokoro-82M v1.0 ONNX (`onnx-community/Kokoro-82M-v1.0-ONNX`), Apache-2.0,
  via `kokoro-js`. Weights are fetched at setup, not committed.
- Ambience: synthesized locally by `tools/make-ambience.cjs`. No third-party audio.
```

This build is personal-use only, so redistribution rights are not a gate — but the notices
stay in the tree either way.

- [ ] **Step 3: Run the app and listen**

Run: `npm run dev`

Check, with four or more agents on the floor:
- two agents at a table hold a conversation whose bubbles change exactly when the voices do;
- gaps between beats are short (a beat, not a pause) and the exchange never stalls;
- a work-status bubble ("edit …", "bash …") is drawn but never spoken;
- starting a realtime session silences the floor before the mic opens, and the floor stays
  silent for the whole session;
- push-to-talk dictation does the same;
- muting speech in Settings mid-line stops it, and unmuting does not replay it;
- an agent pulled back to work mid-sentence goes quiet immediately.

- [ ] **Step 4: Package and soak (Windows)**

Run: `npm run dist:win`

Then, on the packaged build: cold start offline, warm restart, four or more agents, ten
minutes of idle soak, minimize/restore and sleep/resume, and a mic-bleed check on both
Realtime and Free Flow.

- [ ] **Step 5: Write the handoff**

Append to `C:\Obs\Mark\Web work\office-agent\office-agent.md` a section covering:
- what shipped (the director, audio-timed conversations, original banter, shape-only
  reactions, the mic hand-off, the bounded cache and bounded failure);
- what was verified (the suites above, plus the listening checks actually performed);
- limitations (Pixi-side wiring is covered by source-shape tests, not behavioural ones; the
  acceptance latencies are measured by ear in the packaged build, not asserted in CI);
- next steps (measure the p95 start latency properly; consider whether the gossip strings
  from `t()` should move into a pool so they are not subject to the privacy guard at runtime).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/assets/ATTRIBUTION.md
git commit -m "docs(audio): attribution for the speech model and ambience"
```

---

## Self-Review

**Spec coverage.** Every line of the spec maps to a task: the stall fix and audio-authoritative
timing (Task 3), prepare-ahead and the 200-450 ms reply gap (Task 3), cancellation on leave /
resume / despawn / close (Tasks 4 and 9), strict turn-taking and the single quiet overlap at
-12 dB with panning and a two-voice ceiling (Tasks 1 and 4), visual-only bubbles and explicit
spoken intents with ids, conversation ids, beat indexes, priority, eligibility, expiry, pan
and callbacks (Tasks 2, 6 and 9), captions on real playback start and restoration afterwards
(Tasks 6 and 9), 20-40 s cadence and the 12 s reaction cooldown (Tasks 4 and 8), original
banter (Task 7), shape-only reactions with a privacy canary (Tasks 2 and 7), the 16/6 and
200-entry/64 MiB bounds (Tasks 4 and 5), the `onended` handle with `ended`/`stop()`,
overlap-safe ducking and output limiting (Task 1), the mic hand-off with a 100 ms fade and
awaited silence (Tasks 6 and 10), the 15 s timeout with one restart then session disable
(Task 5), and no schema or settings churn (Global Constraints). The test plan's fake-clock,
provider/mixer, privacy and mic suites are Tasks 3-7 and 10; the packaged listening test and
the vault handoff are Task 11.

**Known gaps, stated rather than hidden.** Two of the spec's acceptance targets — cached
speech starting within 200 ms p95, and no line starting more than three seconds after
becoming eligible — are properties of real synthesis latency and are checked by ear in Task
11's packaged soak, not asserted in CI. The director guarantees the scheduling half of both
(`maxSleepMs` bounds the wake-up delay at 500 ms), but not the model's own speed.
`OfficeFloor.tsx` and `Character.ts` are covered by source-shape assertions only, because
they import Pixi and cannot be loaded by `test/load-ts.cjs`; that is the reason every policy
decision was pushed into a pure module.

**Type consistency.** `SpeechPlayback` (mixer, Task 1) and `SpeechPlaybackHandle` (director,
Task 3) are two names for the same structural shape — `{ durationMs, ended, stop(fadeMs?) }` —
deliberately, so the director never imports Web Audio. `officeSpeech.ts` is where the two
meet, and `Mixer.playSpeech` satisfies `SpeechPlaybackHandle` structurally. `SpeakOptions`
uses `onStart`/`onEnd` throughout; the old `onDuration` name is gone as of Task 6 Step 8.
`TtsProvider.disabled` is added in Task 5 and read in Task 6's sink. `pan` is a number in
-1..1 everywhere.
