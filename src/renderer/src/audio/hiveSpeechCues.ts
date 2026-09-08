import type { SpeechPriority } from './speechIntent';

export const HIVE_SPEECH_HISTORY_LIMIT = 256;

export type HiveSpeechAct =
  | 'request'
  | 'inform'
  | 'propose'
  | 'query'
  | 'agree'
  | 'refuse'
  | 'done';

/** Renderer-facing shape of the main process's content-free delivery event. */
export interface ConfirmedHiveDelivery {
  id: string;
  conversation: string;
  inReplyTo: string | null;
  from: string;
  deliveredTargets: string[];
  act: HiveSpeechAct;
  requiresReply: boolean;
  needsHuman: boolean;
}

export interface HiveSpeechCue {
  eventId: string;
  agentId: string;
  text: string;
  priority: SpeechPriority;
  conversationId?: string;
  beatIndex?: number;
}

/** The only words a hive delivery is allowed to put into TTS. Event ids,
 * agent ids and task/message content are never interpolated into these lines. */
const ACT_CUES: Record<HiveSpeechAct, readonly string[]> = {
  request: ['I have a handoff for you.', 'Could you take this one?', 'Sending a request your way.'],
  inform: ['Quick update from my side.', 'Passing along an update.', 'Here is the latest from me.'],
  propose: ['I have an idea for the team.', 'Let me float a proposal.', 'I have a possible way forward.'],
  query: ['Can I get a second set of eyes?', 'I have a question for the room.', 'Could someone sanity check this?'],
  agree: ['That works for me.', 'I am on board with that.', 'Sounds good from my side.'],
  refuse: ['I need to push back on that.', 'I cannot take that as it stands.', 'That route does not work for me.'],
  done: ['That piece is wrapped.', 'My part is ready.', 'That handoff is complete.']
};

const HUMAN_CUES = [
  'I need a human decision here.',
  'This one needs human judgment.',
  'I am raising this for a human call.'
] as const;

const ACTS = new Set<string>(Object.keys(ACT_CUES));

interface SeenDelivery extends ConfirmedHiveDelivery {
  audible: boolean;
  audibleConversationId?: string;
  beatIndex?: number;
}

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

const validToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;

/** Treat the preload boundary as untrusted even though TypeScript knows the
 * nominal shape. A malformed event produces no animation text and no audio. */
export function isConfirmedHiveDelivery(value: unknown): value is ConfirmedHiveDelivery {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<ConfirmedHiveDelivery>;
  if (!validToken(event.id) || !validToken(event.conversation) || !validToken(event.from)) return false;
  if (!(event.inReplyTo === null || validToken(event.inReplyTo))) return false;
  if (!ACTS.has(String(event.act))) return false;
  if (typeof event.requiresReply !== 'boolean' || typeof event.needsHuman !== 'boolean') return false;
  if (!Array.isArray(event.deliveredTargets) || event.deliveredTargets.length < 1 || event.deliveredTargets.length > 64) return false;
  if (!event.deliveredTargets.every(validToken)) return false;
  if (new Set(event.deliveredTargets).size !== event.deliveredTargets.length) return false;
  return event.deliveredTargets.every((target) => target !== event.from);
}

/** Turns confirmed hive deliveries into catalog-only speech. It remembers a
 * bounded slice of this renderer session solely to dedupe and correlate real
 * reverse-direction replies; it never retains message content because the event
 * contract never supplies any. */
export class HiveSpeechBroker {
  private readonly seen = new Map<string, SeenDelivery>();

  get historySize(): number { return this.seen.size; }

  accept(value: unknown): HiveSpeechCue | null {
    if (!isConfirmedHiveDelivery(value)) return null;
    const event = value;
    if (this.seen.has(event.id)) return null;

    const reverse = this.findStrictReverse(event);
    const isStandaloneBroadcast = event.deliveredTargets.length > 1 && !event.requiresReply &&
      (event.act === 'inform' || event.act === 'done');
    // Every root gets its own audible id even if an upstream producer reuses a
    // conversation token. Only a strict real reverse delivery inherits it.
    const conversationId = reverse?.audibleConversationId ?? `hive:${event.conversation}:${event.id}`;
    const beatIndex = reverse ? (reverse.beatIndex ?? 0) + 1 : 0;
    const pool = event.needsHuman ? HUMAN_CUES : ACT_CUES[event.act];
    const text = pool[hash(`${event.id}|${event.act}`) % pool.length];
    const cue: HiveSpeechCue = {
      eventId: event.id,
      agentId: event.from,
      text,
      priority: reverse || !isStandaloneBroadcast ? 'conversation' : 'reaction',
      conversationId,
      beatIndex
    };

    this.remember({ ...event, deliveredTargets: [...event.deliveredTargets], audible: false,
      audibleConversationId: conversationId, beatIndex });
    return cue;
  }

  /** Called only after OfficeSpeech accepted the line. An inaudible sender can
   * never create an imaginary first half for a later reply. */
  markSpoken(eventId: string): void {
    const event = this.seen.get(eventId);
    if (event) event.audible = true;
  }

  private findStrictReverse(event: ConfirmedHiveDelivery): SeenDelivery | null {
    if (event.inReplyTo !== null) {
      const parent = this.seen.get(event.inReplyTo);
      return parent && this.isAudibleReverse(parent, event) ? parent : null;
    }
    const prior = [...this.seen.values()].reverse();
    return prior.find((candidate) =>
      candidate.conversation === event.conversation && this.isAudibleReverse(candidate, event)) ?? null;
  }

  private isAudibleReverse(prior: SeenDelivery, event: ConfirmedHiveDelivery): boolean {
    return prior.audible && prior.audibleConversationId !== undefined &&
      prior.conversation === event.conversation &&
      prior.deliveredTargets.includes(event.from) && event.deliveredTargets.includes(prior.from);
  }

  private remember(event: SeenDelivery): void {
    this.seen.set(event.id, event);
    while (this.seen.size > HIVE_SPEECH_HISTORY_LIMIT) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
