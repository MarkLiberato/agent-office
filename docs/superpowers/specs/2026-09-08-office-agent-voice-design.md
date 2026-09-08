# Office Agent — Agent Voices and Office Ambience

Status: approved design, not yet implemented.
Scope: local, personal-use build. Not distributed.

## Problem

The office floor is silent. Agents "talk" only by drawing a `ThoughtBubble`
sprite above their head (`Character.showThought()`, driven from
`OfficeFloor.tsx` and `cafeteriaLines.ts`). There is no audio subsystem in the
app at all — no sound assets, no Web Audio graph, no SFX. The single existing
`new Audio()` belongs to the OpenAI realtime coordinator session
(`src/renderer/src/realtime/session.ts`), which is a separate feature.

We want two things:

1. Agents speak their thought-bubble lines aloud, each in a distinct voice.
2. The office has a background soundscape so it feels inhabited.

## Decisions

**Engine: Kokoro-82M, local, offline.** `kokoro-js@1.2.1` (Apache-2.0) wraps
`@huggingface/transformers` plus a pure-JS `phonemizer`, so there is no native
espeak binary to build per platform. The quantized (q8) ONNX weights are
roughly 86MB — verified against a pinned manifest at fetch time. Kokoro v1.0
ships ~50 voice packs, which is what makes per-agent voices viable.

Rejected: cloud TTS (OpenAI `gpt-4o-mini-tts`) because every bubble becomes a
network round-trip with an ongoing per-line cost, and the app otherwise works
offline. Rejected: Windows SAPI `speechSynthesis` because three robotic system
voices cannot carry fifteen distinct characters. Both remain droppable behind
the `TtsProvider` interface if we change our minds.

**Scope of speech: all thought bubbles**, not just the canned cafeteria pool.
That means synthesis must happen at runtime; pre-rendering a fixed set of clips
is insufficient. The finite cafeteria lines still become effectively free after
first play via the cache.

**Offline forever.** `allowRemoteModels = false`. The model is fetched once
during setup, alongside the existing native-dependency step — never at runtime.

## Architecture

New folder `src/renderer/src/audio/`. Pure logic lives in modules that touch no
DOM at import time, so `test/load-ts.cjs` can load them under `node --test`;
Web Audio and Worker plumbing live in thin shells around them.

| Module | Responsibility | Depends on |
|---|---|---|
| `ttsWorker.ts` | Web Worker. Loads kokoro-js against the local model dir. In: `{id, text, voiceId}`. Out: `{id, pcm, sampleRate}` transferable. | kokoro-js |
| `ttsEngine.ts` | Main-thread facade. Owns the worker, the LRU cache, in-flight dedupe. Implements `TtsProvider`. | worker, cache |
| `ttsCache.ts` | LRU keyed `voiceId\|normalizedText`, cap 200 entries. Pure. | — |
| `voiceCast.ts` | `voiceForAgent()` — character → Kokoro voice id, hash fallback off-roster, god excluded. Pure. | cast.ts, godIdentity |
| `speechQueue.ts` | Concurrency, staleness, rate limiting, realtime-session mute. Pure, injected clock. | — |
| `mixer.ts` | Web Audio graph: master gain → `speech` and `ambience` buses, ducking. | Web Audio |
| `ambience.ts` | Room-tone loop + one-shot scheduling. | mixer |
| `index.ts` | Wiring the above into one `officeAudio` singleton. | all |

### Data flow

```
showThought(text)  ->  speechQueue.enqueue({agentId, text, at})
                          | policy: concurrency, staleness, rate, mute
                       ttsEngine.synth(text, voiceForAgent(agent))
                          | cache hit -> AudioBuffer immediately
                          | miss -> worker -> pcm -> AudioBuffer (cached)
                       mixer.speech.play(buffer)   ambience ducks
                          |
                       bubble TTL extended to audio duration
```

### Model hosting — the one open fork

transformers.js in a renderer fetches model files by URL, but the weights live
on disk outside the asar. Preferred resolution: register an `app://` protocol
in main that serves `resources/tts/`, keeping synthesis in the worker and off
the main process. Known-good fallback if the protocol route fights the
onnxruntime fetch: run kokoro-js in **main** with `onnxruntime-node` and ship
PCM to the renderer over IPC. This is settled in implementation step 1; the
fallback removes it as a project risk.

## Voice casting

`CastMember` in `src/renderer/src/scene/office/cast.ts` gains a `voice` field.
Fifteen characters, hand-cast so nobody collides:

| Character | Voice | Character | Voice |
|---|---|---|---|
| michael | `am_michael` | pam | `af_sarah` |
| jim | `am_adam` | angela | `af_kore` |
| dwight | `am_fenrir` | phyllis | `af_nicole` |
| kevin | `am_puck` | kelly | `af_nova` |
| oscar | `am_eric` | meredith | `af_bella` |
| stanley | `am_onyx` | creed | `bm_lewis` |
| andy | `am_liam` | ryan | `am_echo` |
| toby | `am_santa` | | |

Rules:

- The mapping is validated at load against the voices actually present in the
  fetched voice manifest. A missing id falls back to the hash pool rather than
  throwing, so a model revision cannot break the floor.
- Off-roster agents (not one of the fifteen) get a deterministic hash of their
  agent id into a matching voice pool, so the same agent always sounds the same
  across restarts.
- The coordinator is excluded **by role, not by name**. Mark already speaks
  through the realtime session, and he may occupy any sprite; `godIdentity`
  resolves who he is.

## Queue policy

- One line playing at a time.
- Queue depth 3; overflow drops the oldest pending line.
- A line older than 3s at dequeue is dropped — its bubble has already gone.
- Per-agent floor of 6s between spoken lines.
- Global 800ms gap between lines, so a busy floor is not a wall of talk.
- Bubble TTL extends to `max(existing TTL, audio duration)`.
- Floor speech is muted for the **entire** realtime session — any status other
  than `off` — not merely while Mark is speaking. Otherwise the agents talk
  into an open mic and get transcribed as the user.

## Ambience

A seamless room-tone loop plus a one-shot pool: keyboard bursts, distant phone,
coffee machine, vending thunk, chair creak, printer. Two triggers:

- a randomized 8–25s timer, weighted by how many agents are active;
- events the floor already tracks — an agent arriving at the coffee spot plays
  the machine, the vending spot plays the thunk.

Assets are CC0 (Freesound / Pixabay), mono ogg, a few hundred KB total,
committed under `resources/audio/`. Credits go into the existing
`src/renderer/src/assets/ATTRIBUTION.md`. This build is personal-use only, so
redistribution licensing is not a gate, but attribution is still kept.

## Settings

Config store gains:

```ts
audio: {
  master: number         // 0..1, default 0.5
  speech: boolean        // default true
  speechVolume: number   // default 1
  ambience: boolean      // default true
  ambienceVolume: number // default 0.6
}
```

Surfaced as a section in `SettingsModal`. Strings are added to **all three**
locales — `en`, `ar`, `zh-CN` — not English alone.

## Packaging

- `tools/fetch-voices.cjs` downloads `onnx-community/Kokoro-82M-v1.0-ONNX`
  (q8 weights, tokenizer, voices), verifies sha256 against a pinned manifest,
  writes `resources/tts/`. Idempotent: present-and-valid is a no-op.
- Chained from `tools/setup-native.cjs`; presence verified by
  `tools/check-native.cjs`.
- `resources/tts/` is gitignored — weights do not belong in the repo.
- `electron-builder.yml` gains `extraResources: - from: resources/tts, to: tts`,
  matching the existing `skills` / `kg.cjs` pattern.
- Model dir resolution mirrors `skillsResourceDir()`: repo path in dev,
  `<process.resourcesPath>/tts` when packaged.

## Testing

All under `node --test test/*.test.cjs`, using `test/load-ts.cjs`:

- `tts-voice-cast.test.cjs` — every cast member maps to a distinct voice; the
  same agent id always yields the same voice; unknown ids fall back rather than
  throw; the god role is never assigned a floor voice.
- `tts-speech-queue.test.cjs` — concurrency cap of one; depth-3 overflow drops
  oldest; a 3s-stale line is dropped; per-agent 6s floor holds; nothing is
  dequeued while the realtime session is non-`off`. Injected clock, no timers.
- `tts-cache.test.cjs` — key normalization (trim, case, `{god}` substitution
  applied before keying); LRU evicts at 200; two concurrent requests for the
  same key produce one synth.
- `tts-assets.test.cjs` — every ambience file named by `ambience.ts` exists on
  disk; the `extraResources` entry for `resources/tts` is present in
  `electron-builder.yml`.

Manual verification: `npm run dev`, watch an agent take a coffee break, confirm
the line is audible in that agent's voice, confirm ambience ducks under it,
confirm floor speech goes silent when the realtime session connects.

## Out of scope

- Speaking agent terminal output or status announcements. Bubbles only.
- Giving the coordinator a second, non-realtime voice.
- Lip-sync or mouth animation on the sprites.
- Any cloud TTS provider implementation. The interface admits one; this spec
  does not build one.

## Delivery

After implementation and a green `npm run test:focused` plus `npm run
typecheck`, produce a fresh Windows build with `npm run dist:win`.
