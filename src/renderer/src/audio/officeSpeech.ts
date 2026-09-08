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
import { speechProfileForAgent, voiceForAgent } from './voiceCast';
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
  /** Optional override; callers normally use the stable cast profile. */
  speed?: number;
  /** Optional per-line trim multiplied by the stable cast profile. */
  gain?: number;
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
  private readonly micOwners = new Set<string>();
  private utterances = 0;

  constructor(deps: OfficeSpeechDeps) {
    this.mixer = deps.mixer;
    this.provider = deps.provider;
    this.clock = deps.clock ?? realClock;
    this.director = new SpeechDirector(this.makeSink(), this.clock);
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
    if (!this.enabled || this.micOwners.size > 0 || !this.provider) return null;
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
    if (!voiceId) return null; // the god speaks elsewhere
    const profile = speechProfileForAgent({
      character: opts.character ?? null,
      agentId: opts.agentId
    });

    const now = this.clock.now();
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
      speed: opts.speed ?? profile.speed,
      gain: profile.gain * (opts.gain ?? 1),
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
  private readonly clock: DirectorClock;

  async silence(fadeMs = MIC_FADE_MS, owner = 'default'): Promise<void> {
    this.micOwners.add(owner);
    await this.director.stopAll(fadeMs);
    await this.mixer.stopAllSpeech(fadeMs);
  }

  /** The microphone is closed. Only NEW chatter resumes — nothing is replayed. */
  release(owner = 'default'): void {
    this.micOwners.delete(owner);
  }

  private makeSink(): SpeechSink {
    return {
      prepare: async (intent) => {
        // Best effort: a prepare failure just means the line synthesizes late.
        await this.provider?.synth(intent.text, intent.voiceId, intent.speed);
      },
      play: async (intent, opts) => {
        const provider = this.provider;
        if (!provider) throw new Error('no tts provider');
        let clip;
        try {
          clip = await provider.synth(intent.text, intent.voiceId, intent.speed);
        } catch (err) { throw err; }
        return this.mixer.playSpeech(clip, { gain: opts.gain, pan: opts.pan });
      }
    };
  }
}
