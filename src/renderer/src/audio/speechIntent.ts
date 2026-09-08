// What the floor is allowed to say, and how one line is identified.
//
// A thought bubble is a picture; a SpokenIntent is a commitment to make noise.
// Keeping them separate is what stops live work status ("edit App.tsx") from
// being read aloud — the scene has to ASK for speech, with a line drawn from a
// fixed pool, and every intent carries its own lifetime so a line whose moment
// has passed is dropped rather than spoken late.

export type SpeechPriority = 'conversation' | 'reaction' | 'ambient';

/** Lower wins. A conversation beat must never be pre-empted by small talk. */
export const PRIORITY_RANK: Record<SpeechPriority, number> = {
  conversation: 0,
  reaction: 1,
  ambient: 2
};

export interface SpokenIntent {
  /** Unique per utterance. Two agents may say identical words at once and each
   *  must still be cancellable and captioned on its own. */
  utteranceId: string;
  agentId: string;
  voiceId: string;
  /** Already substituted and already checked by isSpeakable(). */
  text: string;
  priority: SpeechPriority;
  /** Set on both beats of a dialogue so turn order and cancellation are cheap. */
  conversationId?: string;
  /** 0-based position within `conversationId`. Beats play in order. */
  beatIndex?: number;
  /** Not before this time. Reply gaps are expressed by moving this forward. */
  eligibleAt: number;
  /** Dropped unspoken after this time — its moment has gone. */
  expiresAt: number;
  /** Stereo position of the speaker, -1..1, from the avatar's screen x. */
  pan: number;
  /** Fired when audio actually STARTS, with the clip length. Captions hang off this. */
  onStart?: (durationMs: number) => void;
  /** Fired when audio ends, is stopped, or the intent is dropped unspoken. */
  onEnd?: () => void;
}

/** Longest line the floor will speak. Longer than the thought cloud can show and
 *  longer than anyone wants to listen to between two sprites. */
export const MAX_SPOKEN_CHARS = 90;

// Shapes that mean work data reached the synthesizer. This is a backstop for the
// real rule (speech text comes only from cafeteriaLines.ts and reactionLines.ts),
// so it is deliberately blunt: banter has no reason to contain a path, a URL, a
// key, a mail header or a code fragment. Some code keywords (let, var, return,
// export, warn) are excluded even though they appear in the patterns, because they
// are also common in everyday English ("let me hear it", "return to your desk", etc).
// The guard's failure mode of refusing real banter is worse than passing a fragment
// that would trip one of the other patterns, so precision beats recall here.
const FORBIDDEN = [
  /[/\\][\w.-]+[/\\]/,             // a path with at least two separators
  /\.(ts|tsx|js|jsx|json|md|py|rs|go|cjs|mjs|yml|yaml|toml|log|env)\b/i,
  /https?:\/\//i,
  /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,
  /~[/\\]/,
  /\bsk-[a-z0-9-]{8,}/i,
  /\b(subject|from|to|cc|bcc)\s*:/i,
  /\b(error|enoent|eacces|traceback|exception)\b/i,
  /\bcommit\s+[0-9a-f]{6,}\b/i,
  /<[@#!][\w-]+>/,                 // Slack mention / channel tokens
  /[<>{}]|=>|\$\{|`/,              // markup, code and template fragments
  /\b(const|function|await|async|import|bash|npm|git|python|pip)\b/i,
  /\b[0-9a-f]{12,}\b/i             // hashes and ids
];

/** True when this text may be handed to the synthesizer. */
export function isSpeakable(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_SPOKEN_CHARS) return false;
  return !FORBIDDEN.some((re) => re.test(trimmed));
}
