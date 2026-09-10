# Natural Agent Chatter and Responsive Voice

Status: approved design, not yet implemented.
Scope: local, personal-use build (see docs/superpowers/specs/2026-09-08-office-agent-voice-design.md
for the voice subsystem this builds on). Not distributed.

## Problem

The floor speaks, but badly.

1. **It stalls.** `OfficeAudio.pump()` (src/renderer/src/audio/index.ts:109) drains
   `SpeechQueue` in a loop and returns as soon as `next()` yields null. After a line
   finishes, `busyUntil = end + gapMs` still holds for 800 ms, so `next()` returns null
   and the pump exits. Nothing re-wakes it. The queue only drains again when the *next*
   `speak()` call arrives, so pending lines sit silent behind a gap that never expires.
2. **Dialogue is out of sync with audio.** `OfficeFloor.tsx` plays cafeteria exchanges on
   a fixed 2.4 s visual beat while the audio runs at whatever length Kokoro produced.
   Bubbles and voices drift apart within three beats.
3. **Every bubble speaks.** `Character.showThought()` speaks all thought text, including
   live work status ("edit App.tsx", "bash npm test"). That is both noisy and a privacy
   leak into the synthesizer.
4. **The material is borrowed.** `cafeteriaLines.ts` is largely recognizable dialogue from
   *The Office*.
5. **Mic bleed.** Floor speech is muted when the realtime status flips, but the mute is
   not awaited before `getUserMedia`, and Free Flow does not mute at all.

## Decisions

- **A self-waking speech director replaces `SpeechQueue`.** It owns its own timer, so an
  expired gap wakes the floor without a new enqueue.
- **Audio completion is authoritative.** Turn timing comes from the playback `onended`
  handle, never from a fixed visual beat.
- **Turn-based conversations.** One conversation at a time, beats strictly ordered.
  Replies start 200-450 ms after the previous speaker finishes.
- **Rare quiet overlap.** At most one brief background remark may overlap the final 250 ms
  of a foreground line, at -12 dB and spatially panned. Never more than two active voices;
  never an agent overlapping itself.
- **Thought bubbles are visual-only by default.** Speaking requires an explicit spoken
  intent carrying `utteranceId`, optional `conversationId`/`beatIndex`, priority,
  eligibility time, expiry, speaker pan, and start/end callbacks.
- **Captions follow audio.** The spoken caption appears when playback actually starts,
  stays for the clip's length, then restores the underlying work-status bubble.
- **Balanced cadence, fixed.** Roughly one social exchange every 20-40 s when suitable
  agents are available. Work-event reactions carry a 12 s global cooldown. No new setting.
- **Original material.** Recognizable TV quotations are rewritten as original workplace
  sitcom banter. Playful adult humor is allowed; slurs, protected-trait jokes, targeted
  coworker gossip, explicit sexual material and impersonation claims are excluded.
- **Work-aware reactions are shape-only.** A reaction is generated from message act,
  sender/recipient *role* (coordinator / other agent / self), and a coarse status bucket.
  Prompts, task text, subjects, bodies, terminal output, filenames, paths, memory and
  webhook/Slack content never reach TTS.
- **Bounds.** 16 pending utterances globally, 6 per conversation. PCM cache 200 entries
  and 64 MiB.
- **Mic wins.** Before Realtime or Free Flow opens the microphone, all floor speech and
  ambience fade-stop within 100 ms, pending and in-flight chatter is cleared, and the
  caller awaits silence. Only newly created chatter resumes after mic tracks and gates close.
- **Failure is bounded.** Synthesis that exceeds 15 s restarts the worker once; a repeated
  failure disables floor speech for the session while leaving app and ambience controls working.
- **No schema churn.** Existing persisted audio settings and offline assets stay as they
  are. No database, IPC schema, chatter history, transcript storage, or config migration.

## Assumptions

- "Balanced" is the fixed behavior; no chatter-intensity setting is added.
- Kokoro stays the local, offline engine with distinct synthetic character voices.
- Sender/recipient reach the reaction builder as roles, not names — user-chosen agent
  names are still user data, and role is enough to write a line.
- Existing uncommitted workspace changes are the baseline and must be preserved.

## Acceptance

- Cached speech starts within 200 ms p95.
- Prepared turns start within 100 ms of eligibility.
- Dialogue gaps stay 200-450 ms and never require another enqueue to advance.
- No line starts more than three seconds after becoming eligible.
- Mic capture is preceded by confirmed silence in both Realtime and Free Flow.

## Delivery

Green `npm run test:focused` and `npm run typecheck`, then independent Code Reviewer and
Senior Developer approval, then a packaged Windows listening test (4+ agents, offline
cold/warm playback, mic bleed, mute mid-line, minimize/sleep recovery, 10-minute soak).
Verify audio-model and ambience-asset attribution before building a new installer.
Record implementation, validation, limitations and next steps in
`C:\Obs\Mark\Web work\office-agent\office-agent.md`.
