# Agent Voices and Office Ambience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents on the office floor speak their thought-bubble lines aloud in distinct voices using a local Kokoro-82M TTS model, over a background office soundscape.

**Architecture:** A new `src/renderer/src/audio/` subsystem. Pure-logic modules (voice casting, cache, queue policy) carry all the decisions and are unit-tested under `node --test`; Web Audio and Web Worker plumbing are thin shells around them. Kokoro runs in a Web Worker so synthesis never blocks the Pixi render loop. Model weights are fetched once at setup into `resources/tts/`, shipped out-of-asar via `extraResources`, and served to the worker over a custom `app://` protocol registered in main.

**Tech Stack:** `kokoro-js@1.2.1` (Apache-2.0), `@huggingface/transformers` (onnxruntime-web), Web Audio API, Web Workers, Electron `protocol.handle`, Pixi.js (existing scene), `node --test` + `test/load-ts.cjs`.

**Spec:** `docs/superpowers/specs/2026-09-08-office-agent-voice-design.md`

## Global Constraints

- **No git commits.** The user directed: "no need for committing." Every task ends with a verification step instead of a commit step. Do not run `git commit` or `git add` at any point in this plan.
- Model: `onnx-community/Kokoro-82M-v1.0-ONNX`, **q8 / quantized** weights only (~86MB). Never fp32.
- `env.allowRemoteModels = false` at runtime. The app must never fetch a model while running.
- Model files live in `resources/tts/`, **gitignored**. Never commit weights.
- Ambience audio lives in `resources/audio/`, mono `.ogg`, CC0 only, committed.
- Speech concurrency: exactly **1** line at a time. Queue depth **3**. Stale threshold **3000ms**. Per-agent floor **6000ms**. Global gap **800ms**.
- Floor speech is muted whenever the realtime session status is anything other than `'off'`.
- The coordinator is excluded from floor voices **by role (god), not by character name**.
- Cache: LRU keyed `` `${voiceId}|${normalizedText}` ``, capacity **200**.
- Config defaults: `master: 0.5`, `speech: true`, `speechVolume: 1`, `ambience: true`, `ambienceVolume: 0.6`.
- Every user-facing string added to Settings must be added to **all three** locales: `en.json`, `ar.json`, `zh-CN.json`.
- `HarnessConfig` is mirrored in two files and both must be updated: `src/main/config.ts` (interface + `DEFAULTS`) and `src/renderer/src/store/config.ts` (interface only).
- Tests are CommonJS (`test/*.test.cjs`), run with `npm run test:focused`, and load TypeScript via `require('./load-ts.cjs')`. A module under test must not touch `window`, `document`, `AudioContext`, or `Worker` at import time.

---

### Task 1: Fetch and package the Kokoro model

Downloads the model once at setup, keeps it out of git, and ships it out-of-asar. Nothing else can be tested without it on disk.

**Files:**
- Create: `tools/fetch-voices.cjs`
- Create: `tools/tts-manifest.json`
- Modify: `tools/setup-native.cjs` (add a `run(...)` line before `tools/check-native.cjs`)
- Modify: `tools/check-native.cjs` (add a presence check)
- Modify: `.gitignore` (add `resources/tts/`)
- Modify: `electron-builder.yml` (add an `extraResources` entry)
- Test: `test/tts-assets.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `resources/tts/` containing `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`, and `voices/<voiceId>.bin` for every voice in the manifest. Exports from `tools/fetch-voices.cjs`: `module.exports = { MODEL_REPO, FILES, VOICES, ttsDir(), isComplete() }`.

- [ ] **Step 1: Write the failing test**

Create `test/tts-assets.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fetchVoices = require('../tools/fetch-voices.cjs');

test('the manifest names the quantized model, never fp32', () => {
  assert.equal(fetchVoices.MODEL_REPO, 'onnx-community/Kokoro-82M-v1.0-ONNX');
  assert.ok(fetchVoices.FILES.includes('onnx/model_quantized.onnx'));
  assert.ok(!fetchVoices.FILES.some((f) => f.includes('model.onnx')));
});

test('every cast voice is in the fetch list', () => {
  const cast = [
    'am_michael', 'am_adam', 'am_fenrir', 'am_puck', 'am_eric', 'am_onyx',
    'am_liam', 'am_santa', 'am_echo', 'bm_lewis',
    'af_sarah', 'af_kore', 'af_nicole', 'af_nova', 'af_bella'
  ];
  for (const v of cast) assert.ok(fetchVoices.VOICES.includes(v), `missing voice ${v}`);
});

test('model weights are gitignored', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^resources\/tts\/?$/m);
});

test('electron-builder ships the model as an extra resource', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /from:\s*resources\/tts/);
  assert.match(yml, /to:\s*tts/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/tts-assets.test.cjs`
Expected: FAIL — `Cannot find module '../tools/fetch-voices.cjs'`.

- [ ] **Step 3: Write `tools/tts-manifest.json`**

Leave `sha256` empty for now; step 6 fills it from the real download.

```json
{
  "repo": "onnx-community/Kokoro-82M-v1.0-ONNX",
  "revision": "main",
  "files": {
    "config.json": "",
    "tokenizer.json": "",
    "tokenizer_config.json": "",
    "onnx/model_quantized.onnx": ""
  }
}
```

- [ ] **Step 4: Write `tools/fetch-voices.cjs`**

```javascript
#!/usr/bin/env node
'use strict';

// Fetch the Kokoro-82M TTS weights once, at setup, so the app never downloads a
// model while running (the renderer sets allowRemoteModels = false). Mirrors the
// shape of setup-native.cjs: idempotent, safe to re-run, verifies what it wrote.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const manifest = require('./tts-manifest.json');

const MODEL_REPO = manifest.repo;
const FILES = Object.keys(manifest.files);

// The fifteen cast voices (see the spec's casting table) plus the pool the hash
// fallback draws from for off-roster agents.
const VOICES = [
  'am_michael', 'am_adam', 'am_fenrir', 'am_puck', 'am_eric', 'am_onyx',
  'am_liam', 'am_santa', 'am_echo', 'bm_lewis', 'bm_george', 'bm_daniel',
  'af_sarah', 'af_kore', 'af_nicole', 'af_nova', 'af_bella', 'af_heart',
  'bf_emma', 'bf_alice'
];

const ttsDir = () => path.join(root, 'resources', 'tts');

const target = (rel) => path.join(ttsDir(), rel.split('/').join(path.sep));

const allPaths = () => [...FILES, ...VOICES.map((v) => `voices/${v}.bin`)];

function isComplete() {
  return allPaths().every((rel) => {
    const p = target(rel);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function download(rel) {
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${manifest.revision}/${rel}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${rel}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const expected = manifest.files[rel];
  const actual = sha256(buf);
  if (expected && expected !== actual) {
    throw new Error(`checksum mismatch for ${rel}\n  expected ${expected}\n  actual   ${actual}`);
  }
  const dest = target(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { rel, sha256: actual, bytes: buf.length };
}

async function main() {
  if (isComplete()) {
    console.log('Kokoro TTS model already present — skipping.');
    return;
  }
  console.log(`Fetching ${MODEL_REPO} into resources/tts …`);
  const written = [];
  for (const rel of allPaths()) {
    if (fs.existsSync(target(rel)) && fs.statSync(target(rel)).size > 0) continue;
    const r = await download(rel);
    written.push(r);
    console.log(`  ${r.rel} (${(r.bytes / 1e6).toFixed(1)} MB)`);
  }
  // Print checksums so tts-manifest.json can be pinned from a real download.
  const unpinned = written.filter((w) => w.rel in manifest.files && !manifest.files[w.rel]);
  if (unpinned.length) {
    console.log('\nPin these into tools/tts-manifest.json:');
    for (const w of unpinned) console.log(`  "${w.rel}": "${w.sha256}",`);
  }
  console.log('Kokoro TTS model ready.');
}

module.exports = { MODEL_REPO, FILES, VOICES, ttsDir, isComplete };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Wire the config files**

Append to `.gitignore`:

```
# Kokoro TTS weights — fetched by tools/fetch-voices.cjs, never committed.
resources/tts/
```

In `electron-builder.yml`, add to the existing `extraResources:` list, after the `skills` entry:

```yaml
  # Kokoro-82M TTS weights. The renderer's synth worker loads these through the
  # app:// protocol registered in main, so they must live outside the asar.
  - from: resources/tts
    to: tts
```

In `tools/setup-native.cjs`, add before the `run('tools/check-native.cjs')` line:

```javascript
run('tools/fetch-voices.cjs');
```

In `tools/check-native.cjs`, add a check that the model is present and print a clear remedy if not:

```javascript
const { isComplete } = require('./fetch-voices.cjs');
if (!isComplete()) {
  console.error('Kokoro TTS model missing. Run: node tools/fetch-voices.cjs');
  process.exit(1);
}
```

- [ ] **Step 6: Actually fetch the model and pin the checksums**

Run: `node tools/fetch-voices.cjs`
Expected: ~86MB downloaded into `resources/tts/`, then a block of `"path": "sha…"` lines. Paste those hashes into `tools/tts-manifest.json`, then run `node tools/fetch-voices.cjs` again and confirm it prints `already present — skipping.`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/tts-assets.test.cjs`
Expected: 4 tests PASS.

- [ ] **Step 8: Verify nothing large entered git**

Run: `git status --porcelain resources/tts`
Expected: no output. If any file is listed, the `.gitignore` entry is wrong — fix before continuing.

---

### Task 2: Voice casting

Maps a character to a Kokoro voice, deterministically and without the god role.

**Files:**
- Modify: `src/renderer/src/scene/office/cast.ts` (add `voice` to `CastMember` and to all fifteen roster entries)
- Create: `src/renderer/src/audio/voiceCast.ts`
- Test: `test/tts-voice-cast.test.cjs`

**Interfaces:**
- Consumes: `OFFICE_CAST`, `CAST_BY_NAME`, `OfficeCharacterName` from `cast.ts`.
- Produces:
  - `export type KokoroVoiceId = string`
  - `export const FALLBACK_VOICES: readonly KokoroVoiceId[]`
  - `export function voiceForAgent(opts: { character?: OfficeCharacterName | null; agentId: string; isGod?: boolean; available?: readonly KokoroVoiceId[] }): KokoroVoiceId | null` — returns `null` for the god role.

- [ ] **Step 1: Write the failing test**

Create `test/tts-voice-cast.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { voiceForAgent, FALLBACK_VOICES } = loadTs('src/renderer/src/audio/voiceCast.ts');
const { OFFICE_CAST } = loadTs('src/renderer/src/scene/office/cast.ts');

test('every cast member has a distinct voice', () => {
  const voices = OFFICE_CAST.map((c) => c.voice);
  assert.equal(voices.filter(Boolean).length, OFFICE_CAST.length, 'a cast member is missing a voice');
  assert.equal(new Set(voices).size, voices.length, 'two cast members share a voice');
});

test('a cast character always gets its cast voice', () => {
  assert.equal(voiceForAgent({ character: 'dwight', agentId: 'a1' }), 'am_fenrir');
  assert.equal(voiceForAgent({ character: 'pam', agentId: 'zz' }), 'af_sarah');
});

test('the god role never gets a floor voice', () => {
  assert.equal(voiceForAgent({ character: 'michael', agentId: 'a1', isGod: true }), null);
});

test('off-roster agents get a stable hashed voice', () => {
  const first = voiceForAgent({ character: null, agentId: 'agent-1234' });
  const again = voiceForAgent({ character: null, agentId: 'agent-1234' });
  assert.equal(first, again, 'the same agent must sound the same across restarts');
  assert.ok(FALLBACK_VOICES.includes(first));
});

test('a voice missing from the model falls back instead of throwing', () => {
  const available = FALLBACK_VOICES.filter((v) => v !== 'am_fenrir');
  const v = voiceForAgent({ character: 'dwight', agentId: 'a1', available });
  assert.notEqual(v, 'am_fenrir');
  assert.ok(available.includes(v));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/tts-voice-cast.test.cjs`
Expected: FAIL — module `voiceCast.ts` not found.

- [ ] **Step 3: Add `voice` to the cast**

In `src/renderer/src/scene/office/cast.ts`, add to the `CastMember` interface:

```typescript
  /** Kokoro voice id this character speaks with on the floor. Distinct per
   *  character so two agents never sound the same. See audio/voiceCast.ts. */
  voice: string;
```

Then add the field to each of the fifteen `OFFICE_CAST` entries:

```typescript
  { name: 'michael',  displayName: 'Michael',  shirt: '#5a6b8c', blurb: "World's best boss",        voice: 'am_michael' },
  { name: 'jim',      displayName: 'Jim',      shirt: '#6fa8dc', blurb: 'Salesman, prankster',      voice: 'am_adam' },
  { name: 'pam',      displayName: 'Pam',      shirt: '#9caf88', blurb: 'Receptionist, artist',     voice: 'af_sarah' },
  { name: 'dwight',   displayName: 'Dwight',   shirt: '#b89b3e', blurb: 'Assistant (to the) RM',    voice: 'am_fenrir' },
  { name: 'kevin',    displayName: 'Kevin',    shirt: '#4a7ab5', blurb: 'Accounting',               voice: 'am_puck' },
  { name: 'angela',   displayName: 'Angela',   shirt: '#8a86a6', blurb: 'Head of accounting',       voice: 'af_kore' },
  { name: 'oscar',    displayName: 'Oscar',    shirt: '#7a4b6b', blurb: 'Accountant',               voice: 'am_eric' },
  { name: 'stanley',  displayName: 'Stanley',  shirt: '#8c5a4b', blurb: 'Sales, crossword',         voice: 'am_onyx' },
  { name: 'phyllis',  displayName: 'Phyllis',  shirt: '#b08bbf', blurb: 'Sales',                    voice: 'af_nicole' },
  { name: 'andy',     displayName: 'Andy',     shirt: '#6fae6f', blurb: 'Cornell, a cappella',      voice: 'am_liam' },
  { name: 'kelly',    displayName: 'Kelly',    shirt: '#d16ba5', blurb: 'Customer service',         voice: 'af_nova' },
  { name: 'ryan',     displayName: 'Ryan',     shirt: '#3a3a44', blurb: 'The temp',                 voice: 'am_echo' },
  { name: 'toby',     displayName: 'Toby',     shirt: '#9a8c5a', blurb: 'Human resources',          voice: 'am_santa' },
  { name: 'creed',    displayName: 'Creed',    shirt: '#6b7a4b', blurb: 'Quality assurance',        voice: 'bm_lewis' },
  { name: 'meredith', displayName: 'Meredith', shirt: '#b5544a', blurb: 'Supplier relations',       voice: 'af_bella' },
```

- [ ] **Step 4: Write `src/renderer/src/audio/voiceCast.ts`**

```typescript
// Which Kokoro voice each agent speaks with.
//
// Two rules matter. First, an agent must sound the SAME across restarts, so the
// off-roster fallback hashes the agent id rather than picking at random. Second,
// a voice id absent from the shipped model must degrade to the fallback pool
// instead of throwing — a model revision that drops a voice pack should make one
// agent sound different, not silence the whole floor.

import { CAST_BY_NAME, type OfficeCharacterName } from '../scene/office/cast';

export type KokoroVoiceId = string;

/** Pool for agents that are not one of the fifteen roster characters. */
export const FALLBACK_VOICES: readonly KokoroVoiceId[] = [
  'am_michael', 'am_adam', 'am_fenrir', 'am_puck', 'am_eric', 'am_onyx',
  'am_liam', 'am_santa', 'am_echo', 'bm_lewis', 'bm_george', 'bm_daniel',
  'af_sarah', 'af_kore', 'af_nicole', 'af_nova', 'af_bella', 'af_heart',
  'bf_emma', 'bf_alice'
];

/** FNV-1a. Small, stable, and dependency-free — the point is only that the same
 *  agent id always lands on the same voice, not cryptographic quality. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface VoiceForAgentOptions {
  /** Roster character the agent is drawn as, if any. */
  character?: OfficeCharacterName | null;
  /** Stable agent id — the hash seed for off-roster agents. */
  agentId: string;
  /** The coordinator speaks through the realtime session, never the floor. */
  isGod?: boolean;
  /** Voice ids the loaded model actually offers. Omit to trust the full pool. */
  available?: readonly KokoroVoiceId[];
}

/** The voice this agent speaks with, or null if it must not speak on the floor. */
export function voiceForAgent(opts: VoiceForAgentOptions): KokoroVoiceId | null {
  if (opts.isGod) return null;

  const pool = opts.available && opts.available.length
    ? FALLBACK_VOICES.filter((v) => opts.available!.includes(v))
    : FALLBACK_VOICES;
  if (!pool.length) return null;

  const cast = opts.character ? CAST_BY_NAME[opts.character] : undefined;
  if (cast?.voice && pool.includes(cast.voice)) return cast.voice;

  return pool[hash(opts.agentId) % pool.length];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/tts-voice-cast.test.cjs`
Expected: 5 tests PASS.

- [ ] **Step 6: Verify the cast change did not break the scene's typing**

Run: `npm run typecheck:web`
Expected: exit 0. If another file constructs a `CastMember` literal, add its `voice` field too.

---

### Task 3: Synthesis cache

Makes the finite cafeteria pool free after first play, and stops two agents synthesizing the same line twice at once.

**Files:**
- Create: `src/renderer/src/audio/ttsCache.ts`
- Test: `test/tts-cache.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function cacheKey(voiceId: string, text: string): string`
  - `export function normalizeText(text: string): string`
  - `export class TtsCache<T> { constructor(capacity?: number); get(key: string): T | undefined; set(key: string, value: T): void; has(key: string): boolean; readonly size: number }`
  - `export class InFlight<T> { run(key: string, make: () => Promise<T>): Promise<T>; readonly pending: number }`

- [ ] **Step 1: Write the failing test**

Create `test/tts-cache.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { cacheKey, normalizeText, TtsCache, InFlight } =
  loadTs('src/renderer/src/audio/ttsCache.ts');

test('keys ignore surrounding whitespace and case', () => {
  assert.equal(cacheKey('af_sarah', '  Is it Pretzel Day?  '), cacheKey('af_sarah', 'is it pretzel day?'));
});

test('keys separate voices', () => {
  assert.notEqual(cacheKey('af_sarah', 'hello'), cacheKey('am_adam', 'hello'));
});

test('the god token is resolved before keying, not after', () => {
  // Lines carry a {god} placeholder; two different bosses must not share a clip.
  assert.notEqual(normalizeText('do NOT tell Mark I am in here'), normalizeText('do NOT tell Dwight I am in here'));
});

test('the cache evicts least-recently-used at capacity', () => {
  const c = new TtsCache(2);
  c.set('a', 1); c.set('b', 2);
  c.get('a');            // 'a' is now the most recent, so 'b' is next out
  c.set('c', 3);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('c'), true);
  assert.equal(c.size, 2);
});

test('two concurrent requests for one key synthesize once', async () => {
  const flight = new InFlight();
  let calls = 0;
  const make = () => { calls++; return new Promise((r) => setTimeout(() => r('pcm'), 10)); };
  const [x, y] = await Promise.all([flight.run('k', make), flight.run('k', make)]);
  assert.equal(calls, 1);
  assert.equal(x, 'pcm');
  assert.equal(y, 'pcm');
  assert.equal(flight.pending, 0);
});

test('a failed synthesis is not left pending', async () => {
  const flight = new InFlight();
  await assert.rejects(flight.run('k', async () => { throw new Error('boom'); }));
  assert.equal(flight.pending, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/tts-cache.test.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/renderer/src/audio/ttsCache.ts`**

```typescript
// Synthesis cache. The cafeteria pool is finite, so after one pass every quip is
// already an AudioBuffer and costs nothing to replay — only genuinely dynamic
// bubbles ever reach the model.

/** Collapse whitespace and case so "  Is it Pretzel Day? " hits one entry.
 *  Note the {god} token must already be substituted by the caller: two different
 *  coordinators say different words and must not share a clip. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cacheKey(voiceId: string, text: string): string {
  return `${voiceId}|${normalizeText(text)}`;
}

/** Insertion-ordered Map used as an LRU: re-inserting on read moves an entry to
 *  the young end, so the first key iterated is always the least recently used. */
export class TtsCache<T> {
  private readonly map = new Map<string, T>();

  constructor(private readonly capacity = 200) {}

  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** Coalesces concurrent requests for the same key onto one synthesis. */
export class InFlight<T> {
  private readonly running = new Map<string, Promise<T>>();

  run(key: string, make: () => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing) return existing;
    const p = make().finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  get pending(): number {
    return this.running.size;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/tts-cache.test.cjs`
Expected: 6 tests PASS.

---

### Task 4: Speech queue policy

All the "does the floor sound good or like noise" decisions, isolated and testable with an injected clock.

**Files:**
- Create: `src/renderer/src/audio/speechQueue.ts`
- Test: `test/tts-speech-queue.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface SpeechRequest { agentId: string; text: string; voiceId: string; at: number }`
  - `export const QUEUE_LIMITS: { depth: 3; staleMs: 3000; perAgentMs: 6000; gapMs: 800 }`
  - `export class SpeechQueue { constructor(now: () => number); enqueue(req: SpeechRequest): boolean; next(): SpeechRequest | null; markSpoken(req: SpeechRequest, durationMs: number): void; setMuted(muted: boolean): void; readonly depth: number }`

- [ ] **Step 1: Write the failing test**

Create `test/tts-speech-queue.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { SpeechQueue, QUEUE_LIMITS } = loadTs('src/renderer/src/audio/speechQueue.ts');

/** A hand-cranked clock: the queue must never read Date.now() itself. */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const req = (agentId, text, at) => ({ agentId, text, voiceId: 'af_sarah', at });

test('a queued line is handed back once', () => {
  const c = clock();
  const q = new SpeechQueue(c.now);
  q.enqueue(req('a', 'hello', c.now()));
  assert.equal(q.next().text, 'hello');
  assert.equal(q.next(), null);
});

test('nothing is dequeued while a line is still playing', () => {
  const c = clock();
  const q = new SpeechQueue(c.now);
  q.enqueue(req('a', 'one', c.now()));
  q.enqueue(req('b', 'two', c.now()));
  const first = q.next();
  q.markSpoken(first, 1500);
  assert.equal(q.next(), null, 'concurrency must be exactly one');
});

test('the global gap holds after a line finishes', () => {
  const c = clock();
  const q = new SpeechQueue(c.now);
  q.enqueue(req('a', 'one', c.now()));
  q.markSpoken(q.next(), 500);
  c.advance(500);                       // audio done, gap not yet elapsed
  q.enqueue(req('b', 'two', c.now()));
  assert.equal(q.next(), null);
  c.advance(QUEUE_LIMITS.gapMs);
  assert.equal(q.next().text, 'two');
});

test('depth is capped at three and overflow drops the oldest', () => {
  const c = clock();
  const q = new SpeechQueue(c.now);
  for (const t of ['one', 'two', 'three', 'four']) q.enqueue(req('a', t, c.now()));
  assert.equal(q.depth, QUEUE_LIMITS.depth);
  assert.equal(q.next().text, 'two', 'the oldest line should have been dropped');
});

test('a stale line is dropped rather than spoken', () => {
  const c = clock();
  const q = new SpeechQueue(c.now);
  q.enqueue(req('a', 'old', c.now()));
  c.advance(QUEUE_LIMITS.staleMs + 1);
  assert.equal(q.next(), null, 'its bubble is long gone');
});

test('one agent cannot monopolise the floor', () => {
  const c = clock();
  const q = new SpeechQueue(c.now);
  q.enqueue(req('a', 'one', c.now()));
  q.markSpoken(q.next(), 100);
  c.advance(QUEUE_LIMITS.gapMs + 100);
  q.enqueue(req('a', 'two', c.now()));
  q.enqueue(req('b', 'also', c.now()));
  assert.equal(q.next().agentId, 'b', 'agent a is still inside its per-agent floor');
});

test('muting silences the floor entirely', () => {
  const c = clock();
  const q = new SpeechQueue(c.now);
  q.setMuted(true);
  q.enqueue(req('a', 'hello', c.now()));
  assert.equal(q.next(), null);
  q.setMuted(false);
  assert.equal(q.next().text, 'hello');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/tts-speech-queue.test.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/renderer/src/audio/speechQueue.ts`**

```typescript
// Turn-taking for the office floor.
//
// Eight agents all quipping at once is noise, not atmosphere, so exactly one
// line plays at a time, with a beat of silence between lines and a floor on how
// often any single agent may speak. Lines whose bubble has already faded are
// dropped rather than spoken late. The clock is injected so all of this is
// testable without timers.

export interface SpeechRequest {
  agentId: string;
  /** Display text, with {god} already substituted. */
  text: string;
  voiceId: string;
  /** Timestamp the bubble appeared — staleness is measured from here. */
  at: number;
}

export const QUEUE_LIMITS = {
  /** Pending lines held at once; a fourth pushes out the oldest. */
  depth: 3,
  /** A line older than this has lost its bubble and is dropped. */
  staleMs: 3000,
  /** Minimum gap between two lines from the SAME agent. */
  perAgentMs: 6000,
  /** Minimum silence between any two lines. */
  gapMs: 800
} as const;

export class SpeechQueue {
  private readonly pending: SpeechRequest[] = [];
  private readonly lastSpokenAt = new Map<string, number>();
  /** When the floor becomes free again: end of the current audio plus the gap. */
  private busyUntil = 0;
  private muted = false;

  constructor(private readonly now: () => number) {}

  /** Returns false when the line was rejected outright. */
  enqueue(req: SpeechRequest): boolean {
    if (!req.text.trim()) return false;
    this.pending.push(req);
    while (this.pending.length > QUEUE_LIMITS.depth) this.pending.shift();
    return true;
  }

  /** The next line that may be spoken right now, or null. */
  next(): SpeechRequest | null {
    if (this.muted) return null;
    const t = this.now();
    if (t < this.busyUntil) return null;

    while (this.pending.length) {
      const req = this.pending[0];
      if (t - req.at > QUEUE_LIMITS.staleMs) {
        this.pending.shift();          // its bubble is gone; never speak it late
        continue;
      }
      const last = this.lastSpokenAt.get(req.agentId);
      if (last !== undefined && t - last < QUEUE_LIMITS.perAgentMs) {
        // This agent is rate-limited. Let a different agent through instead of
        // stalling the whole floor behind them.
        const other = this.pending.findIndex((p) => {
          const l = this.lastSpokenAt.get(p.agentId);
          return l === undefined || t - l >= QUEUE_LIMITS.perAgentMs;
        });
        if (other === -1) return null;
        return this.pending.splice(other, 1)[0];
      }
      return this.pending.shift()!;
    }
    return null;
  }

  /** Record that `req` is now playing for `durationMs`. */
  markSpoken(req: SpeechRequest, durationMs: number): void {
    const t = this.now();
    this.lastSpokenAt.set(req.agentId, t);
    this.busyUntil = t + Math.max(0, durationMs) + QUEUE_LIMITS.gapMs;
  }

  /** Silence the floor — used for the whole realtime coordinator session, so the
   *  agents never talk into an open mic and get transcribed as the user. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  get depth(): number {
    return this.pending.length;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/tts-speech-queue.test.cjs`
Expected: 7 tests PASS.

---

### Task 5: Serve the model to the renderer

Resolves the open fork in the spec. The worker fetches model files over a custom protocol instead of the network.

**Files:**
- Create: `src/main/ttsProtocol.ts`
- Modify: `src/main/index.ts` (call the registration during app startup, beside the other protocol/window setup)
- Test: `test/tts-protocol.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const TTS_SCHEME = 'office-tts'`
  - `export function ttsResourceDir(): string` — repo `resources/tts` in dev, `<process.resourcesPath>/tts` when packaged.
  - `export function resolveTtsPath(baseDir: string, requestUrl: string): string | null` — pure; returns an absolute path inside `baseDir`, or `null` for traversal or unknown files.
  - `export function registerTtsProtocol(): void`

- [ ] **Step 1: Write the failing test**

Create `test/tts-protocol.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { resolveTtsPath, TTS_SCHEME } = loadTs('src/main/ttsProtocol.ts');

const base = path.resolve('/models/tts');

test('a model file resolves inside the model directory', () => {
  const p = resolveTtsPath(base, `${TTS_SCHEME}://model/onnx/model_quantized.onnx`);
  assert.equal(p, path.join(base, 'onnx', 'model_quantized.onnx'));
});

test('a voice pack resolves', () => {
  const p = resolveTtsPath(base, `${TTS_SCHEME}://model/voices/af_sarah.bin`);
  assert.equal(p, path.join(base, 'voices', 'af_sarah.bin'));
});

test('directory traversal is refused', () => {
  assert.equal(resolveTtsPath(base, `${TTS_SCHEME}://model/../../secrets.env`), null);
  assert.equal(resolveTtsPath(base, `${TTS_SCHEME}://model/onnx/../../../etc/passwd`), null);
});

test('an unexpected extension is refused', () => {
  assert.equal(resolveTtsPath(base, `${TTS_SCHEME}://model/run.exe`), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/tts-protocol.test.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/main/ttsProtocol.ts`**

```typescript
// Serve the Kokoro weights to the renderer's synth worker.
//
// transformers.js fetches model files by URL, but the weights deliberately live
// OUTSIDE the asar (they are shipped through electron-builder's extraResources,
// like resources/skills and kg.cjs). A tiny custom protocol bridges the two, so
// the worker can keep allowRemoteModels = false and still load from disk.
//
// The path resolver is pure and separately tested: anything that escapes the
// model directory, or that is not one of the file types the model is made of,
// is refused rather than served.

import { protocol, net } from 'electron';
import { app } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TTS_SCHEME = 'office-tts';

/** Extensions the model legitimately consists of. Anything else is not ours. */
const ALLOWED = new Set(['.onnx', '.onnx_data', '.json', '.bin', '.txt']);

/** Repo path in dev, unpacked resources path once packaged — the same split
 *  skillsResourceDir() makes for the bundled skills. */
export function ttsResourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tts')
    : path.join(app.getAppPath(), 'resources', 'tts');
}

export function resolveTtsPath(baseDir: string, requestUrl: string): string | null {
  let rel: string;
  try {
    // office-tts://model/onnx/model_quantized.onnx -> onnx/model_quantized.onnx
    rel = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!rel) return null;
  if (!ALLOWED.has(path.extname(rel).toLowerCase())) return null;

  const resolved = path.resolve(baseDir, rel);
  const root = path.resolve(baseDir);
  // path.relative escaping upward is the containment check; a bare prefix
  // comparison would let /models/tts-evil through.
  const within = path.relative(root, resolved);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) return null;
  return resolved;
}

export function registerTtsProtocol(): void {
  protocol.handle(TTS_SCHEME, async (request) => {
    const file = resolveTtsPath(ttsResourceDir(), request.url);
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}
```

- [ ] **Step 4: Register the scheme and the handler in `src/main/index.ts`**

Privileged registration must happen **before** `app.whenReady()`. Near the top of the module, beside the other pre-ready setup:

```typescript
import { protocol } from 'electron';
import { TTS_SCHEME, registerTtsProtocol } from './ttsProtocol';

// Must run before app is ready. `supportFetchAPI` lets the synth worker fetch
// these URLs; `bypassCSP` keeps the renderer's CSP from blocking the weights.
protocol.registerSchemesAsPrivileged([
  { scheme: TTS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
]);
```

Then inside the existing `app.whenReady().then(...)` body, before the first window is created:

```typescript
registerTtsProtocol();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/tts-protocol.test.cjs`
Expected: 4 tests PASS.

- [ ] **Step 6: Verify main still typechecks**

Run: `npm run typecheck:node`
Expected: exit 0.

---

### Task 6: The synth worker and engine

**Files:**
- Create: `src/renderer/src/audio/ttsWorker.ts`
- Create: `src/renderer/src/audio/ttsEngine.ts`
- Modify: `package.json` (add the `kokoro-js` dependency)

**Interfaces:**
- Consumes: `TtsCache`, `InFlight`, `cacheKey` (Task 3); `TTS_SCHEME` value `'office-tts'` (Task 5).
- Produces:
  - `export interface SynthResult { pcm: Float32Array; sampleRate: number }`
  - `export interface TtsProvider { synth(text: string, voiceId: string): Promise<SynthResult>; voices(): Promise<string[]>; warm(): Promise<void>; dispose(): void }`
  - `export class KokoroProvider implements TtsProvider`

- [ ] **Step 1: Install the dependency**

Run: `npm install kokoro-js@1.2.1 --save`
Expected: `kokoro-js` appears in `package.json` dependencies. Do not run `npm audit fix`.

- [ ] **Step 2: Write `src/renderer/src/audio/ttsWorker.ts`**

```typescript
/// <reference lib="webworker" />
//
// Kokoro synthesis, off the main thread.
//
// Pixi drives a continuous render loop on the main thread; running ONNX
// inference there would drop frames on every quip. The worker owns the model and
// hands back raw PCM as a transferable, so nothing large is ever copied.
//
// Two details make offline loading work. First, allowRemoteModels = false, so
// transformers.js will not reach the network. Second, kokoro-js resolves its
// voice packs against huggingface.co by a URL baked into the library, so we
// intercept fetch and rewrite any huggingface.co request onto the office-tts://
// protocol that main serves from resources/tts.

import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

const MODEL_ORIGIN = 'office-tts://model';

// Rewrite the library's hub URLs onto our local protocol. Anything that is not a
// hub URL passes through untouched.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('huggingface.co')) {
    // .../<repo>/resolve/<rev>/<path>  ->  office-tts://model/<path>
    const tail = url.split('/resolve/')[1];
    const rel = tail ? tail.split('/').slice(1).join('/') : url.split('huggingface.co/')[1];
    return nativeFetch(`${MODEL_ORIGIN}/${rel}`, init);
  }
  return nativeFetch(input as RequestInfo, init);
}) as typeof fetch;

env.allowRemoteModels = false;
env.allowLocalModels = true;

export type WorkerRequest =
  | { type: 'warm'; id: number }
  | { type: 'voices'; id: number }
  | { type: 'synth'; id: number; text: string; voiceId: string };

export type WorkerResponse =
  | { type: 'ready'; id: number }
  | { type: 'voices'; id: number; voices: string[] }
  | { type: 'audio'; id: number; pcm: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string };

let ttsPromise: Promise<KokoroTTS> | null = null;

function load(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm'
    });
  }
  return ttsPromise;
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'warm') {
      await load();
      post({ type: 'ready', id: msg.id });
      return;
    }
    if (msg.type === 'voices') {
      const tts = await load();
      post({ type: 'voices', id: msg.id, voices: Object.keys(tts.voices ?? {}) });
      return;
    }
    const tts = await load();
    const audio = await tts.generate(msg.text, { voice: msg.voiceId as never });
    const pcm = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
    post({ type: 'audio', id: msg.id, pcm, sampleRate: audio.sampling_rate }, [pcm.buffer]);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
```

- [ ] **Step 3: Write `src/renderer/src/audio/ttsEngine.ts`**

```typescript
// Main-thread face of the synth worker.
//
// Owns the worker, the LRU cache and request coalescing, and hides all of it
// behind TtsProvider so a cloud or system-voice provider can be swapped in later
// without any caller changing.

import { TtsCache, InFlight, cacheKey } from './ttsCache';
import type { WorkerRequest, WorkerResponse } from './ttsWorker';

export interface SynthResult {
  pcm: Float32Array;
  sampleRate: number;
}

export interface TtsProvider {
  /** Synthesize one line. Cached results resolve immediately. */
  synth(text: string, voiceId: string): Promise<SynthResult>;
  /** Voice ids the loaded model actually offers. */
  voices(): Promise<string[]>;
  /** Pay the model-load cost up front so the first real quip is not late. */
  warm(): Promise<void>;
  dispose(): void;
}

export class KokoroProvider implements TtsProvider {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private readonly cache = new TtsCache<SynthResult>(200);
  private readonly flight = new InFlight<SynthResult>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.waiting.get(event.data.id);
      if (!pending) return;
      this.waiting.delete(event.data.id);
      if (event.data.type === 'error') pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    };
    worker.onerror = (event) => {
      // A worker-level failure orphans every outstanding request; fail them all
      // rather than leaving the queue waiting forever on a dead worker.
      const err = new Error(event.message || 'tts worker failed');
      for (const [, p] of this.waiting) p.reject(err);
      this.waiting.clear();
    };
    this.worker = worker;
    return worker;
  }

  private send(msg: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    const worker = this.ensure();
    const id = ++this.seq;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  async warm(): Promise<void> {
    await this.send({ type: 'warm' });
  }

  async voices(): Promise<string[]> {
    const res = await this.send({ type: 'voices' });
    return res.type === 'voices' ? res.voices : [];
  }

  async synth(text: string, voiceId: string): Promise<SynthResult> {
    const key = cacheKey(voiceId, text);
    const hit = this.cache.get(key);
    if (hit) return hit;
    return this.flight.run(key, async () => {
      const res = await this.send({ type: 'synth', text, voiceId });
      if (res.type !== 'audio') throw new Error('unexpected synth response');
      const out: SynthResult = { pcm: res.pcm, sampleRate: res.sampleRate };
      this.cache.set(key, out);
      return out;
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
  }
}
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: exit 0. If `kokoro-js` types disagree on `tts.voices` or `audio.sampling_rate`, read `node_modules/kokoro-js/types/` and adjust the two lines that touch them — do not add `any` casts beyond the `voiceId as never` already present.

- [ ] **Step 5: Prove the model actually loads and speaks**

Run: `npm run dev`, then in the renderer devtools console:

```javascript
const { KokoroProvider } = await import('/src/audio/ttsEngine.ts');
const p = new KokoroProvider();
console.time('warm'); await p.warm(); console.timeEnd('warm');
const r = await p.synth('is it pretzel day?', 'af_sarah');
console.log(r.sampleRate, r.pcm.length);
```

Expected: `warm` completes with no network error, and the synth returns a non-empty `Float32Array` at 24000 Hz. **If the fetch interceptor fails to resolve voice packs**, fall back to the route named in the spec: move `KokoroTTS` into the main process with `onnxruntime-node` and return PCM over IPC, keeping the `TtsProvider` interface unchanged so no caller moves.

---

### Task 7: Audio mixer

**Files:**
- Create: `src/renderer/src/audio/mixer.ts`

**Interfaces:**
- Consumes: `SynthResult` (Task 6).
- Produces:
  - `export class Mixer { constructor(); setMaster(v: number): void; setSpeechVolume(v: number): void; setAmbienceVolume(v: number): void; playSpeech(result: SynthResult): Promise<number>; get ambienceBus(): GainNode; get context(): AudioContext; resume(): Promise<void> }` — `playSpeech` resolves with the clip duration in ms.

- [ ] **Step 1: Write `src/renderer/src/audio/mixer.ts`**

```typescript
// The Web Audio graph.
//
//   speech  ──► speechGain ──┐
//                            ├──► master ──► destination
//   ambience ─► ambGain ─────┘
//
// Speech ducks ambience rather than fighting it: the room drops to a third of
// its level for the length of the line and eases back afterwards, so a quip is
// intelligible without the user reaching for the volume.

const DUCK_FACTOR = 0.33;
const DUCK_ATTACK_S = 0.08;
const DUCK_RELEASE_S = 0.4;

export class Mixer {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly speechGain: GainNode;
  private readonly ambGain: GainNode;
  private ambienceLevel = 0.6;

  constructor() {
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.speechGain = this.context.createGain();
    this.ambGain = this.context.createGain();
    this.master.gain.value = 0.5;
    this.speechGain.gain.value = 1;
    this.ambGain.gain.value = this.ambienceLevel;
    this.speechGain.connect(this.master);
    this.ambGain.connect(this.master);
    this.master.connect(this.context.destination);
  }

  /** Browsers start the context suspended until a gesture; call on first click. */
  async resume(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
  }

  setMaster(v: number): void {
    this.master.gain.value = Math.min(1, Math.max(0, v));
  }

  setSpeechVolume(v: number): void {
    this.speechGain.gain.value = Math.min(1, Math.max(0, v));
  }

  setAmbienceVolume(v: number): void {
    this.ambienceLevel = Math.min(1, Math.max(0, v));
    this.ambGain.gain.value = this.ambienceLevel;
  }

  get ambienceBus(): GainNode {
    return this.ambGain;
  }

  /** Play one synthesized line; resolves with its duration in ms. */
  async playSpeech(result: { pcm: Float32Array; sampleRate: number }): Promise<number> {
    await this.resume();
    const buffer = this.context.createBuffer(1, result.pcm.length, result.sampleRate);
    buffer.copyToChannel(result.pcm, 0);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.speechGain);

    const t = this.context.currentTime;
    const g = this.ambGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.ambienceLevel * DUCK_FACTOR, t + DUCK_ATTACK_S);
    g.setValueAtTime(this.ambienceLevel * DUCK_FACTOR, t + buffer.duration);
    g.linearRampToValueAtTime(this.ambienceLevel, t + buffer.duration + DUCK_RELEASE_S);

    source.start();
    return buffer.duration * 1000;
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck:web`
Expected: exit 0.

---

### Task 8: Office ambience

**Files:**
- Create: `resources/audio/room-tone.ogg`, `keyboard-1.ogg`, `keyboard-2.ogg`, `phone-distant.ogg`, `coffee-machine.ogg`, `vending-thunk.ogg`, `chair-creak.ogg`, `printer.ogg`
- Create: `src/renderer/src/audio/ambience.ts`
- Modify: `src/renderer/src/assets/ATTRIBUTION.md` (credit each clip)
- Modify: `test/tts-assets.test.cjs` (add the asset-presence test)

**Interfaces:**
- Consumes: `Mixer` (Task 7).
- Produces:
  - `export const AMBIENCE_FILES: { readonly loop: string; readonly oneShots: readonly string[] }`
  - `export class Ambience { constructor(mixer: Mixer); start(): Promise<void>; stop(): void; setActivity(activeAgents: number): void; trigger(kind: 'coffee' | 'vending' | 'printer' | 'phone'): void }`

- [ ] **Step 1: Source the audio**

Download eight CC0 clips from Freesound (filter: License = Creative Commons 0) or Pixabay. Convert each to mono ogg at 22.05 kHz:

```bash
ffmpeg -i input.wav -ac 1 -ar 22050 -c:a libvorbis -q:a 3 resources/audio/room-tone.ogg
```

`room-tone.ogg` must be a seamless 30–60s loop; the rest are short one-shots. Keep the total under ~1MB. Record each source URL and its license — the next step needs them.

- [ ] **Step 2: Credit the clips**

Append to `src/renderer/src/assets/ATTRIBUTION.md`:

```markdown
## Office ambience (resources/audio/)

All clips are CC0 (public domain dedication). Source URLs:

- `room-tone.ogg` — <url>
- `keyboard-1.ogg` — <url>
- `keyboard-2.ogg` — <url>
- `phone-distant.ogg` — <url>
- `coffee-machine.ogg` — <url>
- `vending-thunk.ogg` — <url>
- `chair-creak.ogg` — <url>
- `printer.ogg` — <url>
```

- [ ] **Step 3: Add the asset test**

Append to `test/tts-assets.test.cjs`:

```javascript
test('every ambience clip named in code exists on disk', () => {
  const loadTs = require('./load-ts.cjs');
  const { AMBIENCE_FILES } = loadTs('src/renderer/src/audio/ambience.ts');
  for (const rel of [AMBIENCE_FILES.loop, ...AMBIENCE_FILES.oneShots]) {
    const p = path.join(root, 'resources', 'audio', rel);
    assert.ok(fs.existsSync(p), `missing ambience asset ${rel}`);
    assert.ok(fs.statSync(p).size > 0, `empty ambience asset ${rel}`);
  }
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node --test test/tts-assets.test.cjs`
Expected: FAIL — `ambience.ts` not found.

- [ ] **Step 5: Write `src/renderer/src/audio/ambience.ts`**

```typescript
// Room tone plus incidental office noises.
//
// Two triggers, deliberately. A randomized timer keeps the room alive when
// nothing is happening, and the floor calls trigger() on events it already
// tracks — an agent reaching the coffee spot really does start the machine. The
// timer's cadence tightens as more agents work, so a busy office sounds busier.

import type { Mixer } from './mixer';

export const AMBIENCE_FILES = {
  loop: 'room-tone.ogg',
  oneShots: [
    'keyboard-1.ogg',
    'keyboard-2.ogg',
    'phone-distant.ogg',
    'coffee-machine.ogg',
    'vending-thunk.ogg',
    'chair-creak.ogg',
    'printer.ogg'
  ]
} as const;

const EVENT_CLIP: Record<'coffee' | 'vending' | 'printer' | 'phone', string> = {
  coffee: 'coffee-machine.ogg',
  vending: 'vending-thunk.ogg',
  printer: 'printer.ogg',
  phone: 'phone-distant.ogg'
};

/** Idle floor waits up to 25s between noises; a full floor waits about 8s. */
const IDLE_MAX_MS = 25000;
const BUSY_MIN_MS = 8000;

export class Ambience {
  private readonly buffers = new Map<string, AudioBuffer>();
  private loopSource: AudioBufferSourceNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activity = 0;
  private running = false;

  constructor(private readonly mixer: Mixer) {}

  private url(file: string): string {
    // Vite serves resources/audio through the renderer's public path; the assets
    // are static and hashed at build time by the bundler.
    return new URL(`../../../../resources/audio/${file}`, import.meta.url).href;
  }

  private async load(file: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(file);
    if (cached) return cached;
    const res = await fetch(this.url(file));
    const decoded = await this.mixer.context.decodeAudioData(await res.arrayBuffer());
    this.buffers.set(file, decoded);
    return decoded;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.mixer.resume();

    const bed = await this.load(AMBIENCE_FILES.loop);
    const source = this.mixer.context.createBufferSource();
    source.buffer = bed;
    source.loop = true;
    source.connect(this.mixer.ambienceBus);
    source.start();
    this.loopSource = source;

    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.loopSource?.stop();
    this.loopSource = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** More active agents, more incidental noise. */
  setActivity(activeAgents: number): void {
    this.activity = Math.max(0, activeAgents);
  }

  trigger(kind: keyof typeof EVENT_CLIP): void {
    void this.playOneShot(EVENT_CLIP[kind]);
  }

  private async playOneShot(file: string): Promise<void> {
    if (!this.running) return;
    const buffer = await this.load(file);
    const source = this.mixer.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.mixer.ambienceBus);
    source.start();
  }

  private schedule(): void {
    if (!this.running) return;
    const busyness = Math.min(1, this.activity / 6);
    const window = IDLE_MAX_MS - (IDLE_MAX_MS - BUSY_MIN_MS) * busyness;
    const delay = BUSY_MIN_MS + Math.random() * Math.max(0, window - BUSY_MIN_MS);
    this.timer = setTimeout(() => {
      const pool = AMBIENCE_FILES.oneShots;
      void this.playOneShot(pool[Math.floor(Math.random() * pool.length)]);
      this.schedule();
    }, delay);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/tts-assets.test.cjs`
Expected: 5 tests PASS.

---

### Task 9: Wire the floor

The task where it actually makes noise: bubbles become speech, the coordinator's session mutes the floor, and break spots trigger sounds.

**Files:**
- Create: `src/renderer/src/audio/index.ts`
- Modify: `src/renderer/src/scene/office/OfficeFloor.tsx` (call `officeAudio.speak(...)` wherever `showThought(...)` is called; trigger ambience at break spots)
- Modify: `src/renderer/src/scene/office/ThoughtBubble.ts` (accept a TTL override so the bubble outlives the audio)

**Interfaces:**
- Consumes: `KokoroProvider` (Task 6), `Mixer` (Task 7), `Ambience` (Task 8), `SpeechQueue` (Task 4), `voiceForAgent` (Task 2).
- Produces:
  - `export const officeAudio: OfficeAudio`
  - `export class OfficeAudio { init(): Promise<void>; speak(opts: { agentId: string; character?: OfficeCharacterName | null; isGod?: boolean; text: string; onDuration?: (ms: number) => void }): void; setMuted(muted: boolean): void; setActivity(n: number): void; trigger(kind: 'coffee' | 'vending' | 'printer' | 'phone'): void; applyConfig(cfg: { master: number; speech: boolean; speechVolume: number; ambience: boolean; ambienceVolume: number }): void }`

- [ ] **Step 1: Write `src/renderer/src/audio/index.ts`**

```typescript
// One singleton the scene talks to. Everything above this file is testable in
// isolation; this is the only place they are wired together.

import { KokoroProvider, type TtsProvider } from './ttsEngine';
import { Mixer } from './mixer';
import { Ambience } from './ambience';
import { SpeechQueue, type SpeechRequest } from './speechQueue';
import { voiceForAgent } from './voiceCast';
import type { OfficeCharacterName } from '../scene/office/cast';

export interface AudioConfig {
  master: number;
  speech: boolean;
  speechVolume: number;
  ambience: boolean;
  ambienceVolume: number;
}

export class OfficeAudio {
  private mixer: Mixer | null = null;
  private provider: TtsProvider | null = null;
  private ambience: Ambience | null = null;
  private queue: SpeechQueue | null = null;
  private availableVoices: string[] = [];
  private speechEnabled = true;
  private pumping = false;
  private readonly durationCallbacks = new Map<string, (ms: number) => void>();

  async init(): Promise<void> {
    if (this.mixer) return;
    this.mixer = new Mixer();
    this.provider = new KokoroProvider();
    this.ambience = new Ambience(this.mixer);
    this.queue = new SpeechQueue(() => Date.now());
    // Pay the model-load cost now so the first real quip is not two seconds late.
    await this.provider.warm();
    this.availableVoices = await this.provider.voices();
  }

  applyConfig(cfg: AudioConfig): void {
    this.speechEnabled = cfg.speech;
    this.mixer?.setMaster(cfg.master);
    this.mixer?.setSpeechVolume(cfg.speechVolume);
    this.mixer?.setAmbienceVolume(cfg.ambienceVolume);
    if (cfg.ambience) void this.ambience?.start();
    else this.ambience?.stop();
  }

  /** Mute the whole floor — used for the entire realtime coordinator session. */
  setMuted(muted: boolean): void {
    this.queue?.setMuted(muted);
  }

  setActivity(n: number): void {
    this.ambience?.setActivity(n);
  }

  trigger(kind: 'coffee' | 'vending' | 'printer' | 'phone'): void {
    this.ambience?.trigger(kind);
  }

  speak(opts: {
    agentId: string;
    character?: OfficeCharacterName | null;
    isGod?: boolean;
    text: string;
    onDuration?: (ms: number) => void;
  }): void {
    if (!this.speechEnabled || !this.queue) return;
    const voiceId = voiceForAgent({
      character: opts.character ?? null,
      agentId: opts.agentId,
      isGod: opts.isGod,
      available: this.availableVoices.length ? this.availableVoices : undefined
    });
    if (!voiceId) return;                        // the god speaks elsewhere
    const req: SpeechRequest = { agentId: opts.agentId, text: opts.text, voiceId, at: Date.now() };
    if (opts.onDuration) this.durationCallbacks.set(`${req.agentId}|${req.text}`, opts.onDuration);
    this.queue.enqueue(req);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.queue || !this.provider || !this.mixer) return;
    this.pumping = true;
    try {
      for (;;) {
        const req = this.queue.next();
        if (!req) return;
        try {
          const result = await this.provider.synth(req.text, req.voiceId);
          const ms = await this.mixer.playSpeech(result);
          this.queue.markSpoken(req, ms);
          const key = `${req.agentId}|${req.text}`;
          this.durationCallbacks.get(key)?.(ms);
          this.durationCallbacks.delete(key);
          // Wait out the clip before considering the next line.
          await new Promise((r) => setTimeout(r, ms));
        } catch {
          // A failed line must never wedge the floor: charge the agent for it
          // and move on to the next one.
          this.queue.markSpoken(req, 0);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

export const officeAudio = new OfficeAudio();
```

- [ ] **Step 2: Extend the bubble's lifetime to the audio**

In `src/renderer/src/scene/office/ThoughtBubble.ts`, find the constant that governs how long a bubble lingers before `startLinger()` fades it, and add a method:

```typescript
  /** Hold this bubble at least `ms` — the agent is still saying the line. */
  holdFor(ms: number): void {
    this.holdUntil = Math.max(this.holdUntil ?? 0, performance.now() + ms);
  }
```

Add the `private holdUntil = 0;` field, and in the update/fade path, skip starting the linger while `performance.now() < this.holdUntil`.

Mirror it on `Character` in `src/renderer/src/scene/office/Character.ts`, beside `showThought`:

```typescript
  /** Keep the thought cloud up for the length of the spoken line. */
  holdThought(ms: number): void {
    this.thoughtBubble.holdFor(ms);
  }
```

- [ ] **Step 3: Speak every bubble in `OfficeFloor.tsx`**

Import the singleton:

```typescript
import { officeAudio } from '../../audio';
```

Initialize it once where the scene sets up (beside the other one-time scene init), and apply config:

```typescript
void officeAudio.init();
```

Then at each `showThought(...)` call site — including the cafeteria beat player around line 757 — pair it with a `speak`. For the cafeteria exchange:

```typescript
const speaker = (b.chat.idx % 2 === 0) ? rt : runtimes.get(b.chat.partnerId);
const line = b.chat.lines[b.chat.idx];
speaker?.character.showThought(line);
if (speaker) {
  officeAudio.speak({
    agentId: speaker.agentId,
    character: speaker.characterName,
    isGod: speaker.isGod,
    text: line,
    onDuration: (ms) => speaker.character.holdThought(ms)
  });
}
```

Use the same three fields (`agentId`, `characterName`, `isGod`) that the runtime object already carries; if a runtime lacks `isGod`, derive it the same way the surrounding code already distinguishes the coordinator.

- [ ] **Step 4: Trigger ambience at the break spots**

Where the floor already knows an agent has arrived at a break spot (the `BreakSpot` handling that feeds `pickSoloLine`), add:

```typescript
if (spot === 'coffee') officeAudio.trigger('coffee');
else if (spot === 'vending') officeAudio.trigger('vending');
```

And where the floor knows how many agents are working, keep the room's busyness in step:

```typescript
officeAudio.setActivity(activeAgentCount);
```

- [ ] **Step 5: Mute the floor for the whole realtime session**

In `src/renderer/src/App.tsx`, where `useRealtimeMichael()` state is already consumed, add:

```typescript
useEffect(() => {
  // Any status other than 'off' means the mic may be open — floor speech would
  // be picked up and transcribed as the user.
  officeAudio.setMuted(realtime.status !== 'off');
}, [realtime.status]);
```

- [ ] **Step 6: Verify it typechecks**

Run: `npm run typecheck`
Expected: exit 0 for both projects.

- [ ] **Step 7: Hear it**

Run: `npm run dev`. Wait for an agent to take a coffee break.
Expected: the quip is audible in that agent's voice, the room tone ducks under it, the bubble stays up until the line finishes, and a coffee-machine sound plays on arrival. Connect the realtime coordinator and confirm the floor goes silent.

---

### Task 10: Settings

**Files:**
- Modify: `src/main/config.ts` (add `audio` to `HarnessConfig` and `DEFAULTS`)
- Modify: `src/renderer/src/store/config.ts` (add `audio` to the mirrored `HarnessConfig`)
- Modify: `src/renderer/src/components/SettingsModal.tsx` (add the section)
- Modify: `src/renderer/src/i18n/locales/en.json`, `ar.json`, `zh-CN.json`
- Test: `test/audio-config.test.cjs`

**Interfaces:**
- Consumes: `AudioConfig` (Task 9).
- Produces: `HarnessConfig.audio?: AudioConfig` in both mirrors, with defaults present.

- [ ] **Step 1: Write the failing test**

Create `test/audio-config.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('both HarnessConfig mirrors declare the audio block', () => {
  assert.match(read('src/main/config.ts'), /audio\?:\s*AudioSettings/);
  assert.match(read('src/renderer/src/store/config.ts'), /audio\?:\s*AudioSettings/);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/audio-config.test.cjs`
Expected: FAIL on all three tests.

- [ ] **Step 3: Add the config type and defaults**

In `src/main/config.ts`, beside the other config interfaces:

```typescript
/** Office floor audio: agent voices (local Kokoro TTS) and room ambience.
 *  Mirrored in src/renderer/src/store/config.ts — keep the two in sync. */
export interface AudioSettings {
  /** Overall output level, 0..1. */
  master: number;
  /** Do agents speak their thought bubbles aloud? */
  speech: boolean;
  speechVolume: number;
  /** Room tone and incidental office noises. */
  ambience: boolean;
  ambienceVolume: number;
}
```

Add to the `HarnessConfig` interface:

```typescript
  /** Floor audio (voices + ambience). Mirrors src/renderer/src/store/config.ts. */
  audio?: AudioSettings;
```

Add to `DEFAULTS`:

```typescript
  audio: { master: 0.5, speech: true, speechVolume: 1, ambience: true, ambienceVolume: 0.6 },
```

Then mirror the same `AudioSettings` interface and the `audio?: AudioSettings` field into `src/renderer/src/store/config.ts`.

- [ ] **Step 4: Add the locale strings**

`en.json`, under `settings`:

```json
    "audio": {
      "title": "Office sound",
      "master": "Master volume",
      "speech": "Agents speak their thoughts",
      "speechVolume": "Voice volume",
      "ambience": "Office ambience",
      "ambienceVolume": "Ambience volume"
    }
```

`ar.json`:

```json
    "audio": {
      "title": "صوت المكتب",
      "master": "مستوى الصوت العام",
      "speech": "الوكلاء ينطقون أفكارهم",
      "speechVolume": "مستوى صوت النطق",
      "ambience": "أجواء المكتب",
      "ambienceVolume": "مستوى أصوات الأجواء"
    }
```

`zh-CN.json`:

```json
    "audio": {
      "title": "办公室声音",
      "master": "主音量",
      "speech": "员工朗读想法",
      "speechVolume": "语音音量",
      "ambience": "办公室环境音",
      "ambienceVolume": "环境音音量"
    }
```

- [ ] **Step 5: Add the Settings section**

In `SettingsModal.tsx`, following the existing section pattern (find how the Free Flow or Realtime section is built and copy its structure exactly — same wrappers, same save path), add a section titled `t('settings.audio.title')` with: a master volume slider, a speech toggle, a voice volume slider, an ambience toggle, and an ambience volume slider. On every change, persist through the same config-save call the neighbouring sections use, and call:

```typescript
officeAudio.applyConfig(next.audio);
```

so the change is audible immediately rather than on next launch.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/audio-config.test.cjs`
Expected: 3 tests PASS.

---

### Task 11: Full verification

**Files:** none.

- [ ] **Step 1: Typecheck both projects**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: Run the whole focused suite**

Run: `npm run test:focused`
Expected: every test passes, including the pre-existing ones. If a pre-existing test broke, fix the cause — do not edit the test to match.

- [ ] **Step 3: Manual smoke in dev**

Run: `npm run dev`
Expected, all four: an agent's cafeteria quip is spoken in a distinct voice; two agents never talk over each other; the room tone ducks under speech and returns; toggling Settings → Office sound takes effect immediately.

- [ ] **Step 4: Confirm the app is genuinely offline**

With the app running, open devtools → Network, filter `huggingface`.
Expected: zero requests. Any hit means `allowRemoteModels` or the fetch interceptor is wrong.

---

### Task 12: Build the Windows executable

**Files:** none.

- [ ] **Step 1: Confirm the model is present for packaging**

Run: `node tools/fetch-voices.cjs`
Expected: `already present — skipping.`

- [ ] **Step 2: Build**

Run: `npm run dist:win`
Expected: `dist/Office-Agent-<version>-win-x64-setup.exe` and the portable exe are produced, with no packaging errors.

- [ ] **Step 3: Verify the model shipped**

Run: `ls -la dist/win-unpacked/resources/tts`
Expected: `onnx/model_quantized.onnx` (~86MB) and the `voices/` directory are present. If missing, the `extraResources` entry from Task 1 is wrong.

- [ ] **Step 4: Run the packaged app**

Launch `dist/win-unpacked/Office Agent.exe`, wait for an agent to take a break.
Expected: the agent speaks. This is the acceptance test — the dev server serves files differently from the packaged app, so passing in dev is not evidence for the build.

---

## Self-Review

**Spec coverage:** Engine choice and offline constraint → Tasks 1, 5, 6. Speech scope (all bubbles) → Task 9. Voice casting incl. god exclusion → Task 2. Queue policy → Task 4. Cache → Task 3. Mixer/ducking → Task 7. Ambience + assets + attribution → Task 8. Settings + three locales → Task 10. Packaging → Tasks 1, 12. Testing → Tasks 2, 3, 4, 5, 8, 10, 11. The spec's open fork (model hosting) is resolved in Task 5 with the named fallback restated in Task 6 Step 5.

**Type consistency:** `SynthResult` is defined in Task 6 and consumed unchanged by Task 7 (`playSpeech`) and Task 9. `SpeechRequest` and `QUEUE_LIMITS` are defined in Task 4 and used in Tasks 4 and 9. `voiceForAgent`'s option object is defined in Task 2 and called with the same four fields in Task 9. `AudioConfig` (Task 9) and `AudioSettings` (Task 10) are the same shape by design — Task 10's test asserts the field names.

**Commits:** intentionally absent throughout, per the user's directive.
