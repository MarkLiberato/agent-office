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
  /** Next beat index each live conversation is waiting for. An exchange always
   *  starts at beat 0 and advances only as beats finish or are dropped.
   *  "Lowest beat currently pending" is not enough: enqueue() wakes the director
   *  synchronously, so the first beat of a conversation to arrive is trivially
   *  the lowest pending one and would speak out of order. The entry is removed
   *  once the exchange drains, so this map only ever holds live conversations. */
  private readonly progress = new Map<string, number>();
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
    while (this.pending.length > DIRECTOR_LIMITS.maxPending) {
      // Shed the least important, most recently arrived line — which may well be
      // the one that just arrived. A flood of ambient chatter must never push out
      // a conversation beat that is mid-exchange.
      const ordered = [...this.pending].sort((a, b) => this.compare(a, b));
      this.drop(ordered[ordered.length - 1]);
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
    if (filter.conversationId !== undefined) this.progress.delete(filter.conversationId);
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

  /** Ordering: priority first, then eligibility, then arrival. Negative when `a`
   *  should speak before `b`. This cannot be a single number: `eligibleAt` is a
   *  wall-clock millisecond value, so any weighting that folds it in alongside
   *  priority swamps the priority term outright. */
  private compare(a: SpokenIntent, b: SpokenIntent): number {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    if (a.eligibleAt !== b.eligibleAt) return a.eligibleAt - b.eligibleAt;
    return (this.arrival.get(a.utteranceId) ?? 0) - (this.arrival.get(b.utteranceId) ?? 0);
  }

  /** The lowest beat index still pending for a conversation. Used only to decide
   *  what to synthesize ahead — eligibility itself goes through nextBeat(). */
  private headBeat(conversationId: string): number | undefined {
    let head: number | undefined;
    for (const i of this.pending) {
      if (i.conversationId !== conversationId) continue;
      const b = i.beatIndex ?? 0;
      if (head === undefined || b < head) head = b;
    }
    return head;
  }

  /** The beat index this conversation may speak next. */
  private nextBeat(conversationId: string): number {
    return this.progress.get(conversationId) ?? 0;
  }

  /** This beat will not be spoken again — let the exchange move on. Called both
   *  for a beat that finished and for one dropped unspoken, so an expired or
   *  shed beat cannot wedge the rest of the conversation behind it. Only the
   *  AWAITED beat advances the counter: dropping a later beat must not skip the
   *  ones still to come before it. */
  private advanceConversation(intent: SpokenIntent): void {
    const cid = intent.conversationId;
    if (cid === undefined) return;
    const beat = intent.beatIndex ?? 0;
    if (beat !== this.nextBeat(cid)) return;
    this.progress.set(cid, beat + 1);
  }

  /** Forget a conversation once nothing of it is pending or playing. A beat that
   *  later arrives for a forgotten exchange simply never becomes eligible and
   *  expires, which is the right outcome for a conversation that is over. */
  private forgetIfDrained(conversationId: string | undefined): void {
    if (conversationId === undefined) return;
    if (this.pending.some((p) => p.conversationId === conversationId)) return;
    if (this.foreground?.intent.conversationId === conversationId) return;
    if (this.background?.intent.conversationId === conversationId) return;
    this.progress.delete(conversationId);
  }

  private choose(t: number, forOverlap: boolean): SpokenIntent | null {
    const fg = this.foreground;
    const usable = this.pending.filter((i) => {
      if (t < i.eligibleAt) return false;
      if (i.conversationId !== undefined &&
          (i.beatIndex ?? 0) !== this.nextBeat(i.conversationId)) {
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
    return usable.sort((a, b) => this.compare(a, b))[0];
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
      .sort((a, b) => this.compare(a, b))[0];
    if (next) void this.sink.prepare(next).catch(() => { /* prepared lazily instead */ });
  }

  private finish(active: Active): void {
    const wasForeground = !active.background && this.foreground === active;
    if (active.background) {
      if (this.background === active) this.background = null;
    } else if (wasForeground) {
      this.foreground = null;
      // Park the floor while onEnd runs. That callback may queue the next beat of
      // this conversation — it is how the scene drives an exchange — and the
      // nested wake() it triggers must not start that beat with no gap at all.
      this.floorFreeAt = Number.POSITIVE_INFINITY;
    }
    // Advance BEFORE onEnd: the callback queues the next beat, and that beat has
    // to be eligible the moment it lands.
    this.advanceConversation(active.intent);
    // onEnd BEFORE the gap is chosen: gapAfter() reads what is pending, so a reply
    // queued right here is what earns the tight reply gap instead of the long one.
    active.intent.onEnd?.();
    if (wasForeground) this.floorFreeAt = this.clock.now() + this.gapAfter(active.intent);
    // AFTER onEnd, so an exchange that just re-queued itself is not forgotten.
    this.forgetIfDrained(active.intent.conversationId);
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
    this.advanceConversation(intent);
    intent.onEnd?.();
    this.forgetIfDrained(intent.conversationId);
  }

  private dropExpired(t: number): void {
    for (const i of [...this.pending]) if (t >= i.expiresAt) this.drop(i);
  }
}
