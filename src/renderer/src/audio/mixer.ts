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
