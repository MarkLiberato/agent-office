// Room tone plus incidental office noises.
//
// Two triggers, deliberately. A randomized timer keeps the room alive when
// nothing is happening, and the floor calls trigger() on events it already
// tracks — an agent reaching the coffee spot really does start the machine. The
// timer's cadence tightens as more agents work, so a busy office sounds busier.
//
// The clips are synthesized by tools/make-ambience.cjs rather than sampled, so
// there is no third-party audio in the tree. Re-run that script to re-tune them.

import type { Mixer } from './mixer';

export const AMBIENCE_FILES = {
  loop: 'room-tone.wav',
  oneShots: [
    'keyboard-1.wav',
    'keyboard-2.wav',
    'phone-distant.wav',
    'coffee-machine.wav',
    'vending-thunk.wav',
    'chair-creak.wav',
    'printer.wav'
  ]
} as const;

export type AmbienceEvent = 'coffee' | 'vending' | 'printer' | 'phone';

const EVENT_CLIP: Record<AmbienceEvent, string> = {
  coffee: 'coffee-machine.wav',
  vending: 'vending-thunk.wav',
  printer: 'printer.wav',
  phone: 'phone-distant.wav'
};

/** Idle floor waits up to 25s between noises; a full floor waits about 8s. */
const IDLE_MAX_MS = 25000;
const BUSY_MIN_MS = 8000;

// Vite resolves these at build time into hashed asset URLs, so the clips ship
// with the renderer bundle and need no protocol or extraResources entry — unlike
// the 92 MB model, they are small enough to be ordinary assets.
const ASSET_URLS = import.meta.glob('../assets/audio/*.wav', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

function assetUrl(file: string): string | null {
  const key = Object.keys(ASSET_URLS).find((k) => k.endsWith(`/${file}`));
  return key ? ASSET_URLS[key] : null;
}

export class Ambience {
  private readonly buffers = new Map<string, AudioBuffer>();
  private loopSource: AudioBufferSourceNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activity = 0;
  private running = false;

  constructor(private readonly mixer: Mixer) {}

  private async load(file: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(file);
    if (cached) return cached;
    const url = assetUrl(file);
    if (!url) return null;                 // a clip was renamed without its code
    const res = await fetch(url);
    const decoded = await this.mixer.context.decodeAudioData(await res.arrayBuffer());
    this.buffers.set(file, decoded);
    return decoded;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.mixer.resume();

    const bed = await this.load(AMBIENCE_FILES.loop);
    if (bed) {
      const source = this.mixer.context.createBufferSource();
      source.buffer = bed;
      source.loop = true;
      source.connect(this.mixer.ambienceBus);
      source.start();
      this.loopSource = source;
    }

    this.schedule();
  }

  stop(): void {
    this.running = false;
    try {
      this.loopSource?.stop();
    } catch {
      // Already stopped (double stop, or the context went away) — nothing to do.
    }
    this.loopSource = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async fadeStop(ms = 100): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
    this.stop();
  }

  /** More active agents, more incidental noise. */
  setActivity(activeAgents: number): void {
    this.activity = Math.max(0, activeAgents);
  }

  trigger(kind: AmbienceEvent): void {
    void this.playOneShot(EVENT_CLIP[kind]);
  }

  private async playOneShot(file: string): Promise<void> {
    if (!this.running) return;
    const buffer = await this.load(file);
    if (!buffer || !this.running) return;
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
