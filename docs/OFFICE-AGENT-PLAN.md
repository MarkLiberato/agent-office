# Office Agent implementation plan

User objective: a working local Windows application, inspired by Munder Difflin, with an animated office and AI agents performing real tasks.

## Agreed foundation

Adopt upstream commit `3e4f9f62a0f219b45f6428fd62f1a8a546d0f607` from https://github.com/chaitanyagiri/munder-difflin. Preserve MIT notice and asset credits. The separate artwork license needs resolution before external redistribution. This workspace is a local derivative, not an official upstream release.

Planning review completed by Solutions Architect, Data Engineer, Senior Developer, QA Engineer and Legal & Compliance Reviewer. Team Lead resolves the scope as a usable Windows fork retaining upstream office, terminals, workers, and coordination. No simulated task completion.

## Owners and execution

- Platform implementer: separate Office Agent identity/storage; disable upstream updater and analytics; manual permission defaults; no scheduled/background AI by default; provider-aware model selection; Windows CLI/native runtime compatibility.
- Frontend implementer: Office Agent title and setup; align setup with backend defaults; preserve animated office and credits; retain real terminal and stop controls.
- Team Lead: dependency/bootstrap work, runtime integration, factual documentation and handoff.
- Independent Code Reviewer and Senior Developer: review changes and integration before QA.
- QA Engineer: Windows launch, actual provider task, output verification, cancellation, two-worker isolation, persistence, setup accessibility and resize checks.

Platform and frontend changes can run in parallel after this plan; dependency recovery runs alongside them. Any defects repeat implementation, both reviews, and QA.

## Acceptance and limits

The app must open the animated office, accept a selected workspace and authenticated installed provider, perform an actual file-producing task with visible output, support multiple distinct workers and stopping them, and retain configuration/history on relaunch without silently replaying tasks. Verify native PTY and SQLite in Electron, TypeScript checks, relevant upstream regression tests, and production build. Inspect actual listeners and preserve integrations disabled by default. Do not infer execution success from avatar movement or terminal silence.

Local data includes configuration, transcripts, and hive files; selected AI providers may receive prompts and task context. Credentials must never enter repository files or handoff notes. Do not claim universal sandboxing for all providers. Existing undocumented upstream behavior outside the verified workflow must be disclosed rather than assumed production-ready.

## Current progress

- Upstream source cloned; initial architecture, data, senior, QA and license audits completed.
- Dependency recovery done. The first install failed compiling native SQLite for host Node 24; `Setup Office Agent.cmd` now installs the lockfile without scripts and rebuilds native modules against the app's Electron version.
- Platform and frontend changes are implemented and build clean: `npm run typecheck` passes and `npm run build` produces `out/`.
- Test position, measured against an upstream baseline on this machine: 843 tests, 807 passing. The 28 failures are identical to the ones upstream produces here — Windows symlink `EPERM` without Developer Mode, and environment-dependent path/install checks — and none of them are caused by the fork. Three fork behaviours needed their upstream tests taught the new contract rather than the other way round: the coordinator carries the hive protocol as a seed prompt instead of on argv, the removed updater and analytics toggles are no longer staged in Settings, and the Arabic/Chinese locales were brought in line with the rewritten English onboarding copy.
- Runtime verified on Windows 11 on 2026-09-08. The app launches from the bundled Electron runtime, creates its own `Office Agent` application-data folder, opens SQLite (`harness.db`) and paints the animated office. Onboarding was completed end to end against the real wizard: harness home `C:\Obs\Mark`, Claude Code as the coordinator engine on the CLI's own model, auto mode and every background feature left off, telemetry and auto-update written false. The coordinator spawns a live Claude Code terminal in that folder and the hive scaffolding is regenerated under it.
- One defect was found by that live run and fixed: on Windows every Claude hook died with `call: command not found`. Claude executes hooks through `sh`, so the `call` prefix — a cmd.exe builtin needed only by agy's `hooks.json` and Codex's `config.toml` — was moved to a separate `nodeRunCmdShell()` helper, with a regression test pinning that Claude hook commands never carry it.
- Still pending: an actual file-producing task run by the coordinator, two-worker isolation and stop controls, relaunch persistence checks, the independent code review, and the Obsidian handoff note.
