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
  private readonly micOwners = new Set<string>();

  /** Safe to call repeatedly; the model is loaded once. */
  init(): Promise<void> {
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<void> {
    const mixer = new Mixer();
    this.mixer = mixer;
    this.ambience = new Ambience(mixer);
    this.provider = new KokoroProvider();
    this.speech = new OfficeSpeech({ mixer, provider: this.provider });
    this.applyConfig(this.config);
    // A microphone may have opened while the model was loading.
    for (const owner of this.micOwners) void this.speech.silence(MIC_FADE_MS, owner);

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
    if (cfg.ambience && this.micOwners.size === 0) void this.ambience?.start();
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
  async silenceForMic(owner = 'default'): Promise<void> {
    if (this.micOwners.has(owner)) return;
    this.micOwners.add(owner);
    await this.ambience?.fadeStop(MIC_FADE_MS);
    await this.speech?.silence(MIC_FADE_MS, owner);
  }

  /** The microphone is closed. Nothing that was dropped comes back. */
  resumeAfterMic(owner = 'default'): void {
    if (!this.micOwners.delete(owner)) return;
    this.speech?.release(owner);
    if (this.micOwners.size > 0) return;
    this.mixer?.setAmbienceVolume(this.config.ambienceVolume);
    if (this.config.ambience) void this.ambience?.start();
  }
}

export const officeAudio = new OfficeAudio();
