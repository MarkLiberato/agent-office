export const SOCIAL_MIN_MS = 20_000;
export const SOCIAL_MAX_MS = 40_000;
export const REACTION_COOLDOWN_MS = 12_000;
export function nextSocialDelay(random: () => number): number {
  return SOCIAL_MIN_MS + Math.floor(Math.max(0, Math.min(1, random())) * (SOCIAL_MAX_MS - SOCIAL_MIN_MS));
}
