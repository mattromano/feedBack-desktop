# How to run this app

feedBack desktop (Rock Band edition): Electron main process (TypeScript), a vanilla-JS
renderer, a native C++/JUCE audio engine loaded as a Node addon, a sandboxed VST host, and
the bundled feedBack core (Python server + web UI) under `resources/slopsmith`.

Windows only for this engagement.

## Setup

- Node deps: `npm install` (runs `electron-builder install-app-deps`).
- Native engine: `npm run build:audio` (CMake + MSVC, see WINDOWS_BUILD_REQUIREMENTS.md).
  Output: `build/Release/slopsmith_audio.node`. Already built on this machine; reuse it.
- Bundled core + plugins: `scripts/bundle-slopsmith.sh` with `SLOPSMITH_DIR` pointing at a
  clone of `mattromano/feedBack@custom` (see `clone_slopsmith` in `scripts/build-common.sh`).
- `resources/python` and `resources/bin` are already bundled on this machine; reuse them.

## Run (the way the user tests: local packaged build, NOT `npm start`)

```bash
npm run build:ts && npx electron-builder --win --dir
release/win-unpacked/feedback.exe
```

Verified: `release/win-unpacked/feedback.exe` exists and ran this session (ASIO4ALL @256).

After any local build, restore `amps/`, `pedals/`, `racks/` into
`release/win-unpacked/resources/slopsmith/plugins/rig_builder/vst/` from
`%LOCALAPPDATA%\Temp\slopsmith\plugins\rig_builder\vst` (song tones store absolute paths
there). Close the dev/local copy before running the installed app: they share settings and
port 18000.

`npm start` / `npm run dev` also work (dev mode) but the user reported wrong guitar settings
in dev mode; prefer the packaged build for any check the user will hear.

## Test

Only targeted, source-reading tests on this machine. NEVER the full `npm test`.

Safe baseline set (24 files, 155 tests, all passing at baseline, < 1 s):

```bash
node --test $(ls tests/*.test.js | grep -v -E "chain-mutation-storm|contract-check|live-pitch|ml-note-detection|multi-source|napi-arg-fuzz|config-bootstrap|config-reset")
```

Do NOT run locally (they load the native engine, grab ASIO devices and lag the PC):
chain-mutation-storm, contract-check, live-pitch, ml-note-detection, multi-source,
napi-arg-fuzz. The user's notes also exclude config-bootstrap and config-reset (they turn
out to use temp dirs only, but keep them out per the user's rule). Leave those to CI.

C++ unit suites (`tests/engine_units`, `tests/onset_lag`, `tests/chordscorer`, ...) build
with CMake; run individual test executables only, Debug builds, with a timeout.
