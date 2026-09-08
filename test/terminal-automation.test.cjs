'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  canAutomateTerminal,
  isStaleTerminalDraft,
  opensInteractiveTerminalUi,
  shouldFollowTerminalOutput,
  terminalAutomationBlock,
  isStaleTerminalPicker,
  STALE_INPUT_MS,
  STALE_PICKER_MS
} = loadTs('src/renderer/src/components/terminalAutomation.ts');

test('interactive provider commands pause queue automation', () => {
  assert.equal(opensInteractiveTerminalUi('/model'), true);
  assert.equal(opensInteractiveTerminalUi(' /provider '), true);
  assert.equal(opensInteractiveTerminalUi('/compact'), false);
  assert.equal(opensInteractiveTerminalUi('implement this'), false);
});

test('a command with an argument opens no picker to wait for', () => {
  // Only the BARE command opens a picker. `/model sonnet` applies the argument
  // and returns to the prompt, leaving no UI to close — but the picker latch is
  // cleared only by an Enter/Escape/Ctrl-C in that terminal, so latching here
  // wedged the agent's message queue permanently. Matching on the first token
  // alone is what caused it.
  assert.equal(opensInteractiveTerminalUi('/model sonnet'), false);
  assert.equal(opensInteractiveTerminalUi('/permissions allow'), false);
  assert.equal(opensInteractiveTerminalUi(' /provider anthropic '), false);
});

test('terminal automation waits for user drafts and interactive states', () => {
  const ready = { exited: false, pickerOpen: false, inputDirty: false, settleUntil: 0 };
  assert.equal(canAutomateTerminal(ready, 100), true);
  assert.equal(canAutomateTerminal({ ...ready, inputDirty: true }, 100), false);
  assert.equal(canAutomateTerminal({ ...ready, pickerOpen: true }, 100), false);
  assert.equal(canAutomateTerminal({ ...ready, exited: true }, 100), false);
  assert.equal(canAutomateTerminal({ ...ready, settleUntil: 101 }, 100), false);
});

test('an old draft keeps blocking delivery until submitted or cleared', () => {
  const typedAt = 1_000_000;
  const draft = {
    exited: false, pickerOpen: false, inputDirty: true,
    settleUntil: 0, inputDirtyAt: typedAt
  };
  // Fresh draft: the user is mid-sentence, automation must not type over it.
  assert.equal(canAutomateTerminal(draft, typedAt + 1), false);
  assert.equal(isStaleTerminalDraft(draft, typedAt + 1), false);
  // Age alone cannot establish clearance of unsubmitted text.
  assert.equal(isStaleTerminalDraft(draft, typedAt + STALE_INPUT_MS), true);
  assert.equal(canAutomateTerminal(draft, typedAt + STALE_INPUT_MS), false);
  assert.equal(canAutomateTerminal({ ...draft, inputDirty: false }, typedAt + STALE_INPUT_MS), true);
  // A draft with no timestamp keeps the old never-expires behavior.
  assert.equal(canAutomateTerminal({ ...draft, inputDirtyAt: undefined }, typedAt + 1e9), false);
});

test('an old picker keeps blocking delivery until closed', () => {
  const openedAt = 1_000_000;
  const picker = {
    exited: false, pickerOpen: true, inputDirty: false,
    settleUntil: 0, pickerOpenedAt: openedAt
  };
  // While it is plausibly still open, automation must not type into the menu.
  assert.equal(canAutomateTerminal(picker, openedAt + 1), false);
  assert.equal(isStaleTerminalPicker(picker, openedAt + 1), false);
  // The latch is cleared only by Enter/Escape/Ctrl-C typed into that terminal.
  // An old timestamp alone is not evidence that a menu was closed.
  assert.equal(isStaleTerminalPicker(picker, openedAt + STALE_PICKER_MS), true);
  assert.equal(canAutomateTerminal(picker, openedAt + STALE_PICKER_MS), false);
  assert.equal(terminalAutomationBlock(picker, openedAt + STALE_PICKER_MS), 'picker');
  assert.equal(canAutomateTerminal({ ...picker, pickerOpen: false }, openedAt + STALE_PICKER_MS), true);
  // No timestamp ⇒ the old never-expires behavior, so nothing silently changes
  // for a state recorded before this field existed.
  assert.equal(canAutomateTerminal({ ...picker, pickerOpenedAt: undefined }, openedAt + 1e9), false);
});

test('automation block reports why delivery is held', () => {
  const ready = { exited: false, pickerOpen: false, inputDirty: false, settleUntil: 0 };
  assert.equal(terminalAutomationBlock(ready, 100), null);
  assert.equal(terminalAutomationBlock({ ...ready, exited: true }, 100), 'exited');
  assert.equal(terminalAutomationBlock({ ...ready, pickerOpen: true }, 100), 'picker');
  assert.equal(terminalAutomationBlock({ ...ready, inputDirty: true }, 100), 'draft');
  assert.equal(terminalAutomationBlock({ ...ready, settleUntil: 101 }, 100), 'settling');
  // A picker outranks a draft: both are true while a slash menu is open.
  assert.equal(
    terminalAutomationBlock({ ...ready, pickerOpen: true, inputDirty: true }, 100),
    'picker'
  );
});

test('elapsed time never transfers ownership of a draft or picker', () => {
  // Half an hour, both blocks. A 60s window fired while the user had merely
  // paused to think; treating a live draft as abandoned is the expensive
  // mistake, and parking a queued message a while longer is the cheap one.
  assert.equal(STALE_INPUT_MS, 1_800_000);
  assert.equal(STALE_PICKER_MS, 1_800_000);

  const at = 1_000_000;
  const ready = { exited: false, pickerOpen: false, inputDirty: false, settleUntil: 0 };
  const draft = { ...ready, inputDirty: true, inputDirtyAt: at };
  const picker = { ...ready, pickerOpen: true, pickerOpenedAt: at };

  // Ten minutes in, both still belong to the user.
  assert.equal(canAutomateTerminal(draft, at + 600_000), false);
  assert.equal(canAutomateTerminal(picker, at + 600_000), false);

  for (const elapsed of [STALE_INPUT_MS, 86_400_000, 1e9]) {
    assert.equal(canAutomateTerminal(draft, at + elapsed), false);
    assert.equal(canAutomateTerminal(picker, at + elapsed), false);
  }
});

test('terminal output follows only when already at the bottom', () => {
  assert.equal(shouldFollowTerminalOutput(100, 100), true);
  assert.equal(shouldFollowTerminalOutput(99, 100), true);
  assert.equal(shouldFollowTerminalOutput(80, 100), false);
});
