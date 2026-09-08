// One singleton the scene talks to. Everything above this file is testable in
// isolation; this is the only place they are wired together.

import { KokoroProvider, type TtsProvider } from './ttsEngine';
import { Mixer } from './mixer';
import { Ambience, type AmbienceEvent } from './ambience';
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

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  master: 0.5,
  speech: true,
  speechVolume: 1,
  ambience: true,
  ambienceVolume: 0.6
};

export interface SpeakOptions {
  agentId: string;
  character?: OfficeCharacterName | null;
  isGod?: boolean;
  text: string;
  /** Called with the clip length once it starts, so the bubble can outlive it. */
  onDuration?: (ms: number) => void;
}

export class OfficeAudio {
  private mixer: Mixer | null = null;
  private provider: TtsProvider | null = null;
  private ambience: Ambience | null = null;
  private queue: SpeechQueue | null = null;
  private availableVoices: string[] = [];
  private config: AudioConfig = { ...DEFAULT_AUDIO_CONFIG };
  private starting: Promise<void> | null = null;
  private pumping = false;
  private readonly durationCallbacks = new Map<string, (ms: number) => void>();

  /** Safe to call repeatedly; the model is loaded once. */
  init(): Promise<void> {
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<void> {
    this.mixer = new Mixer();
    this.ambience = new Ambience(this.mixer);
    this.queue = new SpeechQueue(() => Date.now());
    this.applyConfig(this.config);

    this.provider = new KokoroProvider();
    try {
      // Pay the model-load cost now so the first real quip is not seconds late.
      await this.provider.warm();
      this.availableVoices = await this.provider.voices();
    } catch (err) {
      // A missing or broken model must not take the office floor down with it:
      // the room keeps its ambience and the agents simply stay quiet.
      console.warn('[audio] TTS unavailable, agents will not speak:', err);
      this.provider = null;
    }
  }

  applyConfig(cfg: AudioConfig): void {
    this.config = cfg;
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

  trigger(kind: AmbienceEvent): void {
    this.ambience?.trigger(kind);
  }

  speak(opts: SpeakOptions): void {
    if (!this.config.speech || !this.queue || !this.provider) return;
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
          const play = await this.mixer.playSpeech(result);
          const ms = play.durationMs;
          this.queue.markSpoken(req, ms);
          const key = `${req.agentId}|${req.text}`;
          this.durationCallbacks.get(key)?.(ms);
          this.durationCallbacks.delete(key);
          // Wait out the clip before considering the next line.
          await new Promise((r) => setTimeout(r, ms));
        } catch (err) {
          // A failed line must never wedge the floor: charge the agent for it
          // and move on to the next one.
          console.warn('[audio] line failed:', err);
          this.queue.markSpoken(req, 0);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

export const officeAudio = new OfficeAudio();
