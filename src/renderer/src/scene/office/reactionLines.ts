/** Shape-only reactions: callers choose from metadata, never task text. */
export type WorkReaction = 'started' | 'finished' | 'blocked' | 'waiting';
const LINES: Record<WorkReaction, readonly string[]> = {
  started: ['the keyboard has entered a new phase', 'someone is making the pixels behave'],
  finished: ['the green light is suspiciously green', 'that task survived the office'],
  blocked: ['the door is closed, metaphorically and literally', 'a dependency has opinions'],
  waiting: ['the office is buffering politely', 'we are awaiting a tiny miracle']
};
export function pickReaction(kind: WorkReaction, seed: number): string {
  const lines = LINES[kind];
  return lines[((seed % lines.length) + lines.length) % lines.length];
}
