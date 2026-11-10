# Refactor Audit - feedBack desktop (Rock Band edition)

**Date**: 2026-11-07
**Auditor**: Claude Code (codebase-untangler skill), four read-only reviewers + spot checks
**Baseline commit**: e610887 (tag `pre-refactor-baseline`, branch `refactor/untangle-2026-11-07`)
**Stack**: Electron 35 + TypeScript main process, vanilla-JS renderer plugin, C++/JUCE native
audio engine (N-API addon), sandboxed VST host, bundled Python core

The structured version of this audit is `.untangler/audit.json` (source of truth). Issue IDs
match. Every finding cites file:line at the baseline commit.

## 1. App Summary

A desktop rhythm game for real guitar (Rocksmith-style) plus Rock Band band play. Electron
hosts the bundled feedBack core (a Python server on port 18000 and its web UI). This repo adds
the desktop shell: window/pane management, auto-update (Velopack; AppImage on Linux), the
native low-latency audio engine (ASIO/WASAPI, amp/NAM/IR/VST chain, pitch and note detection,
song/renderer buses), a crash-isolated VST host, and the `audio_engine` renderer plugin
(`src/renderer/screen.js`) that drives the engine from the UI. Windows is the target that
matters; Mac/Linux build in CI.

## 2. Entry Points

| Type | Path / Trigger | Handler | Notes |
|------|----------------|---------|-------|
| App start | `electron .` / `feedback.exe` | `src/main/main.ts` | Bootstrap order is load-bearing (main.ts:72-107) |
| IPC (~145 channels) | `window.feedBackDesktop.*` | `src/main/preload.ts` -> `audio-bridge.ts`, `main.ts`, `plugin-manager.ts`, `pane-hosts.ts`, `update-manager.ts` | Only ~19 channels in `ipc-channels.ts` |
| Native addon | `build/Release/slopsmith_audio.node` | `src/audio/NodeAddon.cpp` (112 exports) | Contract: `tests/contracts/addon-exports.json` |
| Renderer plugin | core loads `plugin.json` -> `screen.js` | `src/renderer/screen.js` (3 IIFEs) | Single classic script; bundled by `scripts/bundle-slopsmith.sh:181-186` |
| Child process | Python core | `src/main/python.ts:463-769` | Port 18000, restart via `restartPython` |
| Child process | VST host | `src/vst-host/main.cpp` | Sandboxed plugin processing |
| Release | `scripts/release-rockband.sh X.Y.Z` | `.github/workflows/build.yml` | Tags only; CI builds + Velopack packs |

## 3. Module Map

| Path | LOC (approx) | Purpose | Concerns mixed? |
|------|-----|---------|-----------------|
| `src/main` | ~9,000 | Electron main process | Yes - main.ts (9 concerns), audio-bridge.ts (10), python.ts (5) |
| `src/renderer` | ~5,900 | audio_engine UI plugin | Yes - one 4,460-line closure with ~15 features |
| `src/audio` | ~18,000 | Native engine + N-API bindings | Partly - AudioEngine.cpp god-object; earlier extractions are clean |
| `src/vst-host` | ~2,000 | Sandboxed VST host process | Small duplication with VSTScan.cpp |
| `scripts` | ~2,500 | Build/bundle/release shell | Bundling split across 3 dispatchers |
| `.github/workflows` | ~1,500 | CI + releases | Signing/pack steps copied across 3 workflows |
| `tests` | ~6,000 | 30 JS test files + C++ suites | Fast and engine-loading tests mixed in one glob |

Totals: 408 tracked files, 203 code files, ~53,000 code lines (JUCE is a submodule, excluded).

## 4. Hotspots

### Large files (>500 LOC)
- `src/renderer/screen.js` - 5,377 lines (30 commits; #1 by size and churn)
- `src/vst-host/main.cpp` - 1,959
- `src/main/main.ts` - 1,539
- `src/audio/AudioEngine.cpp` - 1,535
- `src/main/audio-bridge.ts` - 1,467
- `src/audio/addon/ChainOps.cpp` - 1,053
- `src/audio/addon/DeviceBindings.cpp` - 968
- `src/main/python.ts` - 949
- `src/audio/SignalChain.cpp` - 876
- `src/main/update-manager.ts` - 821

### High-churn
- `screen.js` 29, `AudioEngine.h` 28, `AudioEngine.cpp`/`NodeAddon.cpp`/`preload.ts`/`main.ts` 23 each,
  `scripts/build-common.sh` 22, `audio-bridge.ts` 17.

Combined LOC+churn top 5: screen.js, AudioEngine.cpp, main.ts, audio-bridge.ts, preload.ts.

## 5. Duplication Catalogue

| ID | What | Locations | Canonical home |
|----|------|-----------|----------------|
| I-004 | Fail-soft addon-call boilerplate (~40 copies), inconsistent guarding | `audio-bridge.ts:505-1205`; unguarded at 602-612, 728, 1010, 1031, 1035, 1040-1056, 1212, 1240, 1273-1298 | `callAddon(name, fallback, ...args)` in audio-bridge |
| I-003 | Bypass preload + MIDI tone switchers implemented twice, already drifted | IIFE1 `screen.js:2301-2340, 2682-2797, 3308-3324`; IIFE2 `4970-4995, 5029-5157` | One factory exported from IIFE1 |
| I-008 | localStorage schemas parsed/written by hand | `slopsmith-tone-mappings` 2545, 4812, 4910 (+ setItem 2981, 2999, 3011); `slopsmith-chain-presets` 1988, 2654; `slopsmith-signal-chain` 9 sites | `window._aeStore` accessors |
| I-009 | JSON config files read/written 4 ways, one non-atomic | `soundfont-manager.ts:73-79` (atomic), `audio-bridge.ts:209-221` (not atomic), `vst-crash-guard.ts:86`, `python.ts:435-441` | `src/main/json-file.ts` |
| I-010 | Resource/config path resolution computed independently | `main.ts:301-305`, `audio-bridge.ts:232-236, 308-310`, `python.ts:107-129, 373, 397, 410-421, 542, 582-586, 636-657` | `src/main/app-paths.ts` |
| I-011 | ~125 IPC channel names as bare strings in 2 files each | `audio-bridge.ts`, `main.ts`, `preload.ts:301-570`; `UpdateChannel` type x3 | `ipc-channels.ts` (after extractor update) |
| I-012 | Duplex vs split output callback mix tail (~60 lines) | `AudioEngine.cpp:1113-1182` vs `1337-1411` | pure `noexcept` helpers first |
| I-013 | N-API int parsing bypasses NapiHelpers (~25 raw `Int32Value`) | `DetectionBindings.cpp`, `DeviceBindings.cpp`, `ControlBindings.cpp:46`, `ChainOps.cpp:806` | `addon/NapiHelpers.h` `argInt`/`argSlotId` |
| I-014 | Ring consume / seqlock patterns open-coded 3x each | `AudioEngine.cpp:1250-1333, 1444-1473`, `StreamSink.cpp:87-104`, `SourceChain.cpp:235-241`, `RendererBus.h:229-317` | `PackedStereoRing::consume`, `SeqlockStamp<T>` |
| I-015 | Legacy vs per-source binding marshalling; 5 near-identical AsyncWorkers | `DetectionBindings.cpp:119-147, 245-449` vs `DeviceBindings.cpp:631-860`; `ChainOps.cpp:419, 636-819` | `toJs(...)` helpers; `queueChainSlotMutation` |
| I-016 | CI signing / vpk pack / vpk version copied across workflows | `build.yml:95-132, 325-459`, `nightly.yml:114-317`, `rc.yml:86-110`; vpk version x3 | composite actions |
| I-017 | Bundling logic split across three dispatchers; SLOPSMITH_DIR discovery copied | `bundle.sh:14-22`, `build-windows.sh`, `build-macos.sh`, `package.json:26`, `bundle-slopsmith.sh:19-27`, `build-windows.sh:124-130` | `resolve_slopsmith_dir` + one dispatcher |

## 6. Boundary Violations

- **I-002** The app-wide desktop config store lives in `soundfont-manager.ts:32-79` and is
  imported by `main.ts:126`, `pane-hosts.ts:28`, `python.ts:12`, which creates a require
  cycle (soundfont-manager imports `restartPython`, line 15).
- **I-018** `window._toneSwitcher` is written from 18 places across both renderer IIFEs, and
  ~37 `window._ae*` globals act as the cross-IIFE bus (the class of bug behind issue #12).
- **I-019** Device-settings validation is duplicated across the IPC boundary
  (`screen.js:155-192` vs `audio-bridge.ts:55-96`).
- **I-020** DeviceSetup and the bindings reach into engine internals: 6 references passed to
  `applySplit` (`AudioEngine.cpp:568-570, 588`), raw `SourceChain*` handed out
  (`AudioEngine.h:413`), and 3 manager getters with no callers (`AudioEngine.h:32-34`).
- **I-021** Test-only loopback lives in production audio callbacks
  (`AudioEngine.h:542-548`, `AudioEngine.cpp:851-862, 1089-1103, 1184-1194`).
- **I-022** C++ test targets are compiled into every release addon build
  (`CMakeLists.txt:61-64`, `SLOPSMITH_BUILD_TESTS` defaults ON), but the tests are never run.

## 7. Dead Code Candidates

Each was verified by grep over `src/` and `tests/`. Check again before deleting.

- `plugins:restart` IPC (`plugin-manager.ts:218-221`): no preload binding, so unreachable.
- Renderer: `meterAnimFrame` (screen.js:28), `ToneSwitcher.teardown` (2791),
  `_aeLinearGainToDb`/`_aeDbToLinearGain`/`_aeFormatGainDbLabel` (110-112),
  `_aeInjectSongTonePicker` (3409), `#ae-tone-automation` (settings.html:62).
- Preload audio methods with no JS caller: `setOutputDeviceType`, `getDeviceMetrics`,
  `getBackingLevel`, `setStreamBusGain`, `getRendererBusMetrics`, `getSongBusMetrics`,
  `isStreamOutputActive`, `getStreamUnderflowCount`, `getStreamOverflowCount`,
  `setSourceMonitorMute`, `moveProcessor`, `isBackingPlaying`. Some of these are diagnostics
  used from DevTools this session (`getSongBusMetrics`), so keep them.
- Addon exports with no caller: `getMonitorMuteState`, `setInputDeviceType` (NodeAddon.cpp:344, 361);
  `getLatencyBreakdown` (362) looks planned, so keep it.
- AudioEngine methods with no caller: `activeExtraInputCount`, `getCurrentDeviceType`,
  `getOutputGain`, `getStreamOutputDeviceName`, single-type `probeDeviceOptions`,
  `setAudioDevice`, `setInputDeviceType`, `sanitizeStreamGain`, `InputDeviceSlot`; unused
  includes in AudioEngine.h:13-23; stale decls in `addon/Bindings.h:116-117`.
- Repo: `tests/spike/` (self-described throwaway), orphaned `tests/chordscorer` and
  `tests/mlnotedetector` (not in `tests/CMakeLists.txt`), `scripts/dev/renderer-bus-spike.js`,
  `scripts/VST_TRACE_README.md`, two unreferenced docs, the `bundle.sh:28` IR step (copies a
  gitignored dir), and the `rc.yml` trigger on `release/**`.

Tracked as **I-023** (one batch, after Top 5).

## 8. Dependency Issues

### Unused
- None found. `lottie-web` is only copied into dist and could be a devDependency.

### Redundant / drift
- **I-005** `package-lock.json` is gitignored (`.gitignore:52`). CI and the build scripts run
  `npm install` with caret ranges (electron `^35.0.0`), so the addon is built against
  whatever Electron 35.x resolves that day. `.build-config.json` has an `electron` version
  that nothing reads.
- **I-024** Windows ffmpeg/vgmstream/get-pip are unpinned "latest" with no checksum
  (`build-windows.sh:108, 184, 224`, `bundle-binaries.sh:139`). macOS is pinned.

### Version concerns
- **I-025** `package.json:3` is frozen at 0.3.0 while tags are at v0.4.17, so
  `app.getVersion()`, the Linux updater (`update-manager.ts:173`), the migration stamp
  (`main.ts:1197`) and Linux artifact names all report 0.3.0.
- Electron 35 is past its support window. Upgrade separately (out of scope).

## 9. Risk Register

| ID | File | Concern | Risk if changed / left |
|----|------|---------|------------------------|
| I-002 | `soundfont-manager.ts:65-79` | A corrupt desktop config is read as `{}` and the next write (every quit, `main.ts:514-523`) drops all prefs | User loses window, LAN, pane and soundfont settings |
| I-006 | `scripts/build-common.sh:211-215` | A failed plugin clone is skipped silently (`2>/dev/null`); a green release can ship without rig_builder/five_fret/rockherosmith | Features vanish for users on auto-update |
| I-026 | `scripts/bundle-slopsmith.sh:176` | Strips `rig_builder/vst`, but song tones store absolute VST paths into it, and local builds don't match CI | Song tones break after a CI release (plugin-side fix needed too) |
| I-003 | `screen.js:4755-4893` vs `4445-4464` | Two song-load pipelines rebuild the native chain; only one holds `_applyToneMappingsLock` | Overlapping clear+load = wrong or empty tone at song start |
| I-007 | `python.ts:943-947`, `main.ts:1325-1342` | `restartPython` races (no serialization, unawaited); port can drift to 18001; Windows grandchildren survive | Renderer talks to a dead port; orphaned Python |
| I-027 | `audio-bridge.ts:1219-1225, 1375`, `plugin-manager.ts:156-173` | Renderer-supplied paths reach the filesystem unchecked; `plugins:remove` is a recursive rm with no confirm | Plugin scripts can write/delete files |
| I-028 | `AudioEngine.cpp:1033,1040,1240`, `SignalChain.cpp:122-170, 260-285`, `SandboxedProcessor.cpp:508-523` | Audio-thread hazards: fprintf, call_once+sigaction on first plugin call, alloc+mutex on plugin crash, up to 4x block wait on the sandbox | Dropouts. Flag only; do not refactor inside the callbacks |
| I-029 | `AudioEngine.cpp:945-948` | `songBusPullScratch` is sized only by the input-side about-to-start | Song audio silently dropped on an output-only start |
| I-030 | `update-manager.ts:261-339` | Linux AppImage self-update never checks size/hash before renaming over the running binary | Truncated download bricks the app (Linux only) |
| I-031 | `screen.js:1582-1588, 1642` | Meter/latency `setInterval`s not kept in `hookState`; re-evaluation stacks pollers | Extra IPC load grows per re-eval |
| I-032 | `main.ts:262-268, 565, 582, 667` | Global handlers log message only (no stack); IPC registered inside `createWindow` | Hard-to-debug failures; "second handler" throw on re-create |
| I-033 | `build.yml:178-182` (+ nightly, rc) | upterm SSH opens on every failed build while signing secrets are loaded | Remote shell on a job holding secrets |

## 10. Test Coverage

- **JS (30 files):** 24 source-only files run locally (155 pass, 0 fail at baseline). 6 load
  the native engine (`chain-mutation-storm`, `contract-check`, `live-pitch`,
  `ml-note-detection`, `multi-source`, `napi-arg-fuzz`).
- **CI runs none of them** (**I-001**): `ci.yml:39-48` runs install, typecheck and audit only.
  `ctest` runs only the sandbox suites (`sandbox.yml`). `tests/engine_units`,
  `audio_sanitize`, `live_pitch`, `onset_lag` never run in CI, and the engine JS tests can't
  run on the owner's machine (they grab ASIO and lag the PC). So the engine-level tests run
  nowhere.
- **`npm test` mixes both kinds** (`package.json:13`), so the only safe local command is a
  long `grep -v` line.
- Renderer tests are all source-reading (extract a function into `vm`, or match literal
  substrings). Nothing exercises init, presets, the tone panel, the IIFE2 preload or the race.
- No tests: main.ts (incl. navigation security predicates), python.ts, update-manager.ts,
  soundfont-manager/desktop config, plugin-manager validators, pane-hosts, vst-crash-guard;
  both C++ output callbacks, DeviceSetup apply*, ExtraInputs, StreamSink, BackingPlayer,
  SignalChain, ChainOps workers.
- **Refactor constraint:** many tests match exact source text (`tests/contracts/extract.js:23-29`
  regex over `ipcMain.handle('...'`, `renderer-iife-scope`, `renderer-capability-migration`
  ~45 substrings, `heard-clock-wiring` exact-count checks). Every Top 5 change has to update
  the affected test in the same commit and keep the contract snapshots identical.

## 11. TOP 5 PRIORITIES

In order. These are what Phase 3 fixes. Each one is behaviour-preserving apart from the noted
safety fixes.

1. **[I-001] Split the test suite; run only the fast tests in CI.** Move the 6 engine-loading
   tests to `tests/engine/`, add `test:fast` / `test:engine` scripts (`test` = fast), and add
   one `npm run test:fast` step to the existing `ci.yml` check job (Ubuntu, after typecheck;
   the suite takes under a second). Scope set by the user on 2026-11-07: no new CI jobs, no
   engine lane, nothing added to the release build (`build.yml`). This is the safety net for
   everything else, and it makes the safe local command one word. Blocks 2-5.
2. **[I-002] Move the desktop config out of soundfont-manager and stop a corrupt file from
   wiping it.** Extract `desktop-config.ts` (re-exported from soundfont-manager for one
   release), which also breaks the require cycle. On a parse failure, keep a `.corrupt`
   backup and don't overwrite blindly. Critical: user settings.
3. **[I-006] Make bundling fail loudly.** A plugin clone that fails stops the build (unless
   `ALLOW_MISSING_PLUGINS=1`), and stderr is no longer hidden. The same goes for the
   desktop-plugin copy (`bundle-slopsmith.sh:185`). Critical: releases.
4. **[I-004] One fail-soft helper for addon calls in audio-bridge.** Add
   `callAddon(name, fallback, ...args)` and `PITCH_NONE`, applied one handler group at a
   time with the literal `ipcMain.handle('...'` lines kept. This removes ~300 lines and fixes
   the ~15 unguarded native calls that can reject into the renderer. Defaults and warn text
   must stay identical.
5. **[I-003] One tone-switcher and one chain lock in the renderer.** Export a single
   bypass/MIDI switcher factory from IIFE1, call it from IIFE2 (removing the drifted copy and
   restoring `tonePresetNameMap` + `normalizeTimelineToneData` there), and route the IIFE2
   song-load preload through `_applyToneMappingsLock`. Needs new vm tests first, plus a check
   on the local packaged build, since it touches what you hear at song start.

Issues 6+ are deferred to a later pass. Next in line: I-005 (lockfile + `npm ci`), I-007
(restartPython race), I-008 (localStorage store), I-025 (version number), I-027 (path
validation).

## 12. Out of Scope

- Framework upgrades (Electron 35 -> current)
- Real-time audio-thread rework (I-028 is flag-only)
- Any change to latency/timing behaviour (just retuned and measured)
- rig_builder absolute-path fix (belongs in the plugin repo; I-026 tracks the desktop side)
- Performance optimisation, new features, visual/UX changes
- Splitting `screen.js` into multiple files (needs a bundle concat step first; later cycle)

## 13. Sign-off

User confirmed Top 5 on: __________ (timestamp recorded in state.json)
