/**
 * Content-free metadata emitted after the hive router has finished attempting
 * delivery. Message text and intended recipients must never cross this event
 * boundary; renderer consumers receive only confirmed recipient ids.
 */
export interface HiveRouteEvent {
  id: string;
  conversation: string;
  inReplyTo: string | null;
  from: string;
  deliveredTargets: string[];
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  requiresReply: boolean;
  needsHuman: boolean;
}
