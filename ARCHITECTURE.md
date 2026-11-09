# Architecture

fee[dB]ack desktop is the Electron shell around the bundled feedBack core (a Python server
on port 18000 plus its web UI). It adds:

- window and pane management
- auto-update
- a native low-latency audio engine
- a crash-isolated VST host
- the `audio_engine` renderer plugin that drives the engine from the UI

Windows is the platform that matters; macOS and Linux build in CI.

```
 renderer (core web UI + plugins)           main process (Node/Electron)          native
 ┌──────────────────────────────┐  IPC   ┌──────────────────────────────┐ N-API ┌──────────────────┐
 │ src/renderer/screen.js       │ ─────► │ preload.ts  (window.feedBack │ ────► │ slopsmith_audio  │
 │  IIFE 1: chain, presets,     │        │             Desktop.*)       │       │ .node (src/audio)│
 │          tone switching      │        │ audio-bridge.ts  (audio:*)   │       └────────┬─────────┘
 │  IIFE 2: song lifecycle,     │        │ main.ts, pane-hosts.ts,      │                │ spawn
 │          preload, monitor    │        │ plugin-manager.ts, update-   │       ┌────────▼─────────┐
 │  IIFE 3: chain button owner  │        │ manager.ts, python.ts ...    │       │ VST host process │
 └──────────────────────────────┘        └──────────────┬───────────────┘       │ (src/vst-host)   │
                                                        │ spawn                 └──────────────────┘
                                               ┌────────▼────────┐
                                               │ Python core     │ resources/slopsmith, :18000
                                               └─────────────────┘
```

## Module layout

| Path | Owns |
|------|------|
| `src/main/main.ts` | App bootstrap (order is load-bearing), windows, app-level IPC |
| `src/main/preload.ts` | The only renderer-facing API (`window.feedBackDesktop`) |
| `src/main/audio-bridge.ts` | Every `audio:*` IPC handler; the only main-process file that loads the native addon |
| `src/main/desktop-config.ts` | `<userData>/slopsmith-desktop.json`: the only reader and writer |
| `src/main/soundfont-manager.ts` | Soundfont quality and download |
| `src/main/python.ts` | Spawning and restarting the Python core |
| `src/main/config-*.ts` | Config paths, bootstrap, migrations, reset |
| `src/main/pane-hosts.ts`, `pane-tray.ts` | Pop-out pane windows |
| `src/renderer/screen.js` | The `audio_engine` plugin, one classic script made of 3 IIFEs |
| `src/audio` | Native engine (JUCE): device I/O, processing chain, detection, buses |
| `src/vst-host` | Sandboxed VST host process |
| `scripts/` | Build, bundle and release shell scripts (`build-common.sh` is the shared core) |
| `tests/*.test.js` | Fast lane: source-reading and stubbed tests, run in CI (`npm run test:fast`) |
| `tests/engine/*.test.js` | Engine lane: loads the built addon, run by hand (`npm run test:engine`) |
| `tests/contracts/` | Snapshots of the addon exports, IPC channels and preload API |

## Rules

These are enforced by `tests/boundaries.test.js` and `tests/test-inventory.test.js`, which
run in CI and in the pre-commit hook.

1. **Native addon:** only `audio-bridge.ts` loads `slopsmith_audio.node` in the main
   process. Everything else goes through its IPC handlers.
2. **Desktop config:** only `desktop-config.ts` reads or writes `slopsmith-desktop.json`.
   Callers import `getDesktopConfig` / `setDesktopConfig` from it. `config-paths.ts` may
   list the file name for reset.
3. **No Node in the renderer:** `src/renderer` never uses `require` or imports `electron`;
   it talks to the main process only through `window.feedBackDesktop`. The main process
   never imports renderer code.
4. **Cross-IIFE calls:** the IIFEs in `screen.js` don't share scope. One IIFE calls into
   another only through a `window._ae*` export, never a bare function name (see
   `renderer-iife-scope.test.js`).
5. **One tone-switch implementation:** every `window._toneSwitcher` that switches tones by
   bypass or MIDI uses `bypassSwitchToTone` / `makeMidiToneSwitcher` (exported as
   `window._aeBypassSwitchToTone` / `window._aeMakeMidiToneSwitcher`). No new inline copies.
6. **One chain lock:** anything that rebuilds the chain for a song runs under
   `withToneChainLock` (`window._aeWithToneChainLock` from IIFE 2).
7. **Guarded addon calls:** a handler whose whole body is "addon missing → fallback; call;
   on throw warn `[audio] <name> failed: …` and return the fallback" uses
   `callAddon(name, fallback, ...args)` instead of a new copy.
8. **Test lanes:** fast-lane tests never load the native addon. Engine tests live in
   `tests/engine/`.

## Known debt

See `.untangler/deferred.md` and `REFACTOR_AUDIT.md`.
