# Office Agent

A local Windows desktop app with an animated office, live agent terminals, and collaborating CLI agents. This is a personal derivative of [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin), pinned initially to `3e4f9f62a0f219b45f6428fd62f1a8a546d0f607`.

## Open

After setup, double-click **Start Office Agent.cmd**. It uses the bundled Electron runtime and does not require Node.js on PATH. If startup fails, check `office-agent-startup.log` in this folder.

For a fresh checkout, install Node.js with npm, then run **Setup Office Agent.cmd**. Setup installs the lockfile dependencies without running their host-runtime build scripts, downloads Electron, prepares native modules for Electron, verifies SQLite and the Windows terminal, then builds the application. Some platforms without supplied native binaries also require a C++ compiler and Python. No global package-manager security settings are changed.

## Building a Windows installer

`npm run dist:win` writes `Office-Agent-<version>-win-x64-setup.exe` (a per-user
NSIS installer) and a portable exe into `dist/`. Neither is code-signed, so
SmartScreen warns on first run; choose "More info" then "Run anyway".

On a Windows account without symlink privilege — Developer Mode off and not
running as administrator — electron-builder cannot unpack its `winCodeSign`
tool, because two macOS symlinks inside that archive fail to extract, and the
installer step never runs. The packaged app still appears in `dist/win-unpacked`.
To recover, extract the cached archive yourself without symlink handling, then
build the installer from the package that already exists:

    node_modules\7zip-bin\win\x64\7za.exe x -bd ^
      "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<id>.7z" ^
      "-o%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"
    npx electron-builder --win --prepackaged dist/win-unpacked

The two `darwin/` symlinks still report errors and can be ignored; a Windows
build only needs `windows-10\x64\signtool.exe`, which extracts normally.
Enabling Developer Mode avoids the whole detour.

## First use

1. Choose an office folder in setup. Keep it separate from source repositories you want workers to edit.
2. Choose a provider installed and signed in on your PC. Codex is selected initially, using its configured model. The office uses the CLI's existing login; an app subscription alone does not prove the CLI is signed in.
3. Finish setup. The coordinator opens a real terminal. Submit your first request to begin work.
4. Add workers for the roles you need and select their working folders. Inspect live output and use the stop controls when needed.

Codex starts with workspace-write access and on-request approvals in manual mode. Different providers have different permission systems; this app does not provide a universal sandbox. Extra office/hive folders are writable for coordination. Explicit automatic mode changes the provider's permission behavior.

## Local behavior

- Configuration and window state use the separate `Office Agent` application-data folder. Office memory and messages use the office folder selected in setup.
- Automatic upstream updates and product analytics are disabled in this derivative.
- Scheduled background missions, semantic memory, memory reflection, microphone capture, Slack, and webhooks start disabled.
- Opening the office does not submit a coordinator orientation prompt. Its instructions accompany the first user request instead.
- An unfinished terminal draft or open menu blocks queued delivery until cleared; it never expires merely because time has passed.
- AI providers may receive prompts, files, and task context. Local transcripts and startup logs can contain task context; do not share them without reviewing their contents.

## Attribution and readiness

Source code remains subject to the preserved upstream MIT notice in `LICENSE`. Bundled office artwork has separate terms in `LICENSE-ASSETS` and `src/renderer/src/assets/ATTRIBUTION.md`; credit to [LimeZu](https://limezu.itch.io/) is retained. Asset redistribution rights need resolution before publishing a new product or distributing this source/build to others.

See `docs/OFFICE-AGENT-PLAN.md` for acceptance criteria and current validation. This document is usage guidance, not a claim that all upstream providers, integrations, or autonomous workflows have been validated.
