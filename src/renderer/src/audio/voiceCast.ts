// Which Kokoro voice each agent speaks with.
//
// Two rules matter. First, an agent must sound the SAME across restarts, so the
// off-roster fallback hashes the agent id rather than picking at random. Second,
// a voice id absent from the shipped model must degrade to the fallback pool
// instead of throwing — a model revision that drops a voice pack should make one
// agent sound different, not silence the whole floor.

import { CAST_BY_NAME, type OfficeCharacterName } from '../scene/office/cast';

export type KokoroVoiceId = string;

export interface SpeechProfile {
  /** Kokoro speaking-rate multiplier. Kept close to natural pace. */
  speed: number;
  /** Per-character linear trim, before the user's speech-volume setting. */
  gain: number;
}

const CAST_PROFILES: Record<OfficeCharacterName, SpeechProfile> = {
  michael: { speed: 1.04, gain: 0.96 },
  jim: { speed: 1.00, gain: 0.92 },
  pam: { speed: 0.98, gain: 0.94 },
  dwight: { speed: 1.06, gain: 0.98 },
  kevin: { speed: 0.94, gain: 0.96 },
  angela: { speed: 1.03, gain: 0.90 },
  oscar: { speed: 0.99, gain: 0.94 },
  stanley: { speed: 0.93, gain: 0.96 },
  phyllis: { speed: 0.96, gain: 0.91 },
  andy: { speed: 1.05, gain: 0.95 },
  kelly: { speed: 1.08, gain: 0.92 },
  ryan: { speed: 1.02, gain: 0.91 },
  toby: { speed: 0.95, gain: 0.90 },
  creed: { speed: 0.92, gain: 0.94 },
  meredith: { speed: 1.01, gain: 0.96 }
};

const FALLBACK_PROFILES: readonly SpeechProfile[] = [
  { speed: 0.96, gain: 0.92 },
  { speed: 1.00, gain: 0.94 },
  { speed: 1.04, gain: 0.96 }
];

/** Pool for agents that are not one of the fifteen roster characters. Kept in
 *  sync with the VOICES list in tools/fetch-voices.cjs — a voice that is not
 *  fetched is not on disk, and picking it would be silence. */
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

/** Stable delivery character without persisting another settings surface. */
export function speechProfileForAgent(opts: Pick<VoiceForAgentOptions, 'character' | 'agentId'>): SpeechProfile {
  if (opts.character) return CAST_PROFILES[opts.character];
  return FALLBACK_PROFILES[hash(opts.agentId) % FALLBACK_PROFILES.length];
}
