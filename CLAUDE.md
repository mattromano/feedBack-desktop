# feedBack desktop

Electron shell around the bundled feedBack core, with a native JUCE audio engine. See
`ARCHITECTURE.md` for the layout and `.untangler/RUNNING.md` for how to build, run and test.

## Codebase Conventions (do not break these)

This repo went through a structural cleanup (`.untangler/`, `REFACTOR_AUDIT.md`). Changes
must keep to these rules. If a task can't, stop and ask the user before going on.

### Architecture

The rules are in `ARCHITECTURE.md`. `tests/boundaries.test.js` enforces them in CI and in
the pre-commit hook. In short:

- Only `src/main/audio-bridge.ts` loads the native addon.
- Only `src/main/desktop-config.ts` reads or writes `slopsmith-desktop.json`.
- The renderer reaches the main process only through `window.feedBackDesktop`.
- The three IIFEs in `src/renderer/screen.js` call each other only through `window._ae*`
  exports, never bare names.
- Tone switchers use `bypassSwitchToTone` / `makeMidiToneSwitcher`.
- Song chain rebuilds run under `withToneChainLock`.
- New "guard, call, warn, fallback" addon handlers use `callAddon()`.

### Before adding code

- Search for an existing implementation first. Extend the canonical one; don't add another
  copy.
- Many tests match exact source text, for example:
  - `tests/contracts/extract.js` relies on literal `ipcMain.handle('…'` lines.
  - `tests/engine/live-pitch.test.js` extracts `audio:setLivePitch` / `audio:getLivePitch`
    verbatim.

  When you change such code, update the matching test in the same commit.
- The contract snapshots (`tests/contracts/*.json`) are the public surface: the addon
  exports, IPC channels and preload API. Change them only on purpose.

### Tests

- Run only the fast, source-reading tests locally (the list is in `.untangler/RUNNING.md`).
  Never run `npm run test:engine` or anything that loads the native addon unless the user
  asks. It grabs the audio device and lags the machine.
- New logic needs a test. A bug fix needs a test that would have caught the bug.
- Never disable or loosen a failing test to get green.
- `tests/fixtures/audio-bridge-fallbacks.snapshot.json` pins every `audio:*` handler's
  fallbacks. Regenerate it (`UPDATE_SNAPSHOT=1`) only for an intended behaviour change, and
  say so in the commit.

### Commits

- Keep refactors and features in separate commits; one logical change each, small diffs.
- Never push, merge or release without the user's explicit go-ahead.
- Check user-facing changes on the local packaged build
  (`npm run build:ts && npx electron-builder --win --dir`), not `npm start`.

### When tempted to rewrite

Don't. Refactor in small steps (the `codebase-untangler` skill) and log side issues in
`.untangler/deferred.md` instead of fixing them on the way.

### Patterns that caused the last cleanup

- Copy-pasting a handler or switcher and editing one line. There were 3 MIDI switchers and
  2 bypass switchers.
- Two code paths rebuilding the same state with no shared lock.
- Catching errors and silently carrying on: missing plugins used to ship unnoticed.
- App-wide state living in an unrelated module (the desktop config sat in
  `soundfont-manager.ts`).
