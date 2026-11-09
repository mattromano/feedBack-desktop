# Untangler handover: feedBack desktop

Branch `refactor/untangle-2026-11-07`, from tag `pre-refactor-baseline` to
`refactor-complete-2026-11-09`. Nothing is pushed or merged. The branch sits on top of the
unpushed latency work (`e610887`, fix/heard-clocks), so it carries those commits too.

## What was audited

The whole repo: Electron main, the `screen.js` renderer plugin, the native engine, the VST
host, build scripts and CI. 33 issues are in `REFACTOR_AUDIT.md` and `.untangler/audit.json`.
You signed off a Top 5.

## What was fixed (Top 5)

| Issue | Change | Commits |
|-------|--------|---------|
| I-001 Test lanes | Engine-loading tests moved to `tests/engine/`. `npm test` = fast lane; `npm run test:engine` on demand. One ~2 s "Fast tests" step in the existing CI check job; no new jobs, nothing in build/release. | `f155640`, `1d2d250` |
| I-002 Desktop config | Read/write moved unchanged into `desktop-config.ts`. An unreadable `slopsmith-desktop.json` is now kept as `.corrupt` instead of being silently replaced. | `34c14bc`, `ec74899` |
| I-006 Missing plugins | A failed plugin clone fails the build (`ALLOW_MISSING_PLUGINS=1` to opt out). The desktop-plugin copy no longer hides errors. All 38 plugin repos checked reachable. | `d6625c5` |
| I-004 Guarded addon calls | `callAddon()` replaces the 7 handlers that were exact copies. The audit's "~40" overcounted; the rest differ in ways that matter. | `caab1da` |
| I-003 Tone switching | One bypass-switch step and one MIDI-switcher factory shared by both IIFEs. IIFE 2 switchers gain the preset-name map. IIFE 2's song preload runs under the same chain lock as tone-mapping applies. | `36ffd5a` |

### How it was verified

- **Safety-net tests first.** Each Top 5 item got its own test, written before the change:
  - an `audio:*` handler snapshot (111 handlers, 3 addon states)
  - a desktop-config behaviour test
  - a bash harness that runs the real clone function
  - tone-switch parity across every install site
  - a test-file inventory

  Each one was broken on purpose to prove it catches regressions.
- **173 fast tests** and the typecheck pass after every change.
- **I-003 in the packaged app**, driven over CDP:
  - Tone changes: switch correctly.
  - Tone lock: holds.
  - Quick song switches: 25/25 in manual mode and 25/25 with Tone Automation.
  - MIDI program changes: correct.
  - Not checked by ear: how it sounds, and whether a VST actually changes patch on MIDI.

## Guard rails now in place

- `ARCHITECTURE.md`: module layout and 8 rules.
- `tests/boundaries.test.js`: enforces the rules in the CI fast lane.
- `scripts/hooks/pre-commit`: about 2 s, boundary rules plus safety nets. **Install once with
  `npm run hooks:install`** (the automated install was blocked).
- `CLAUDE.md`: "Codebase Conventions" for future AI-assisted work.
- `CONTRIBUTING.md`: setup and test commands.

## Overrides

Phase 4, recorded in `.untangler/overrides.log`:

- **ESLint config:** replaced by `tests/boundaries.test.js`, so no new dependencies or CI
  time.
- **Pre-commit install:** pending your `npm run hooks:install`.

## Deferred

The full list is in `.untangler/deferred.md` and `audit.json`. The next three by priority:

1. **MIDI PC mode wipes the chain on song load.** The VST that program changes target is
   gone after load. The same happens on the pre-refactor code. The likely cause is the
   400 ms clear-chain-for-new-song step not exempting MIDI mode.
2. **One song load rebuilds the chain up to 3 times.** The rebuilds are the IIFE 2 preload
   plus the IIFE 1 reapplies at 600 and 1500 ms. They're serialised now, but the work is
   redundant and closes open VST editor windows each time.
3. **I-005: no lockfile.** CI uses `npm install`, so builds aren't reproducible. Commit a
   `package-lock.json` and switch to `npm ci`. I-007, the `restartPython` race, is next
   after that.

## Recommended cadence

About 30 minutes a week on `deferred.md`, one item per small commit. Keep
`npm run test:fast` and the pre-commit guard green. When a pattern starts repeating, add a
rule to `ARCHITECTURE.md` and `tests/boundaries.test.js` together.
