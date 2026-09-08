import type { OfficeCharacterName } from './cast';
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';
type Exchange = readonly string[];
const pick = <T,>(arr: readonly T[], seed: number): T => arr[((seed % arr.length) + arr.length) % arr.length];
const withGod = (line: string, godName: string) => line.replaceAll('{god}', godName);
const SPOTS: Record<BreakSpot, readonly string[]> = {
  coffee: ['this coffee tastes like a budget meeting', 'who moved the good beans?', 'five minutes of peace, allegedly'],
  vending: ['the snack machine has chosen violence', 'B4 is a financial decision', 'one tiny treat, no witnesses'],
  snack: ['these chips are technically team property', 'I call this strategic snacking', 'someone owes the fridge an apology'],
  table: ['the calendar is just a threat with colors', 'I came here to avoid one more ping', 'do not tell {god} I am hiding here']
};
const FLAVOR: Partial<Record<OfficeCharacterName, readonly string[]>> = {
  michael: ['I brought leadership energy and no plan', 'this meeting needs a meeting'],
  dwight: ['I have audited the snack drawer', 'the stapler remains under protection'],
  jim: ['I am conducting a harmless social experiment', 'that spreadsheet looks suspiciously optimistic'],
  pam: ['I sketched the printer having a rough day', 'the break room has a color story'],
  kevin: ['snack first, spreadsheet later', 'I counted the cookies twice'],
  angela: ['this counter is a cry for help', 'the mugs need a better filing system'],
  oscar: ['technically, that is not how budgets work', 'the numbers are judging us'],
  stanley: ['I am on break from being impressed', 'the crossword has better leadership'],
  kelly: ['I have news and absolutely no restraint', 'this is a gossip emergency'],
  ryan: ['I am pivoting the snack strategy', 'the brand direction is caffeine'],
  creed: ['I found this in a drawer, so it is mine now', 'nobody ask where the key came from']
};
export function pickSoloLine(character: OfficeCharacterName, spot: BreakSpot, seed: number, godName: string): string {
  const lines = FLAVOR[character] && seed % 5 < 3 ? FLAVOR[character]! : SPOTS[spot];
  return withGod(pick(lines, seed), godName);
}
const EXCHANGES: readonly Exchange[] = [
  ['did you file the thing?', 'I filed a thing adjacent to it.', 'excellent, we are thriving.'],
  ['the printer is blinking again.', 'blink back. establish dominance.', 'it blinked twice. I am promoted.'],
  ['who scheduled this meeting?', 'future me.', 'future you has questions.'],
  ['I made a risk register.', 'for the snacks?', 'especially for the snacks.'],
  ['the build is green.', 'do not celebrate near it.', 'fine, I will whisper.'],
  ['I am taking a strategic break.', 'that is a nap with a tie.', 'branding matters.'],
  ['can we call this done?', 'we can call it Thursday.', 'close enough for the calendar.'],
  ['I brought a backup plan.', 'is there a first plan?', 'now you are asking dangerous questions.'],
  ['do not tell {god} about the shortcut.', 'the shortcut is wearing a name tag.', 'it was a small shortcut.']
];
export function pickExchange(speaker: OfficeCharacterName, seed: number, godName: string): Exchange {
  return pick(EXCHANGES, seed + speaker.length).map((line) => withGod(line, godName));
}
