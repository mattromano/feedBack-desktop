# Contributing

## Setup

```bash
npm install
npm run hooks:install   # pre-commit guard: boundary rules + safety-net tests, ~2 s
```

Building the native engine and bundling the core are covered in `WINDOWS_BUILD_REQUIREMENTS.md`
and `scripts/BUILD_SCRIPTS.md`.

## Tests

| Command | What runs | Where |
|---------|-----------|-------|
| `npm test` / `npm run test:fast` | `tests/*.test.js`: source-reading and stubbed tests, no native engine | CI (`ci.yml` check job) and locally |
| `npm run test:engine` | `tests/engine/*.test.js`: load the built `slopsmith_audio.node` | Locally, on demand (they open audio devices) |

## Conventions

Read `ARCHITECTURE.md` (module layout and rules). `tests/boundaries.test.js` enforces the
rules. In short:

- One logical change per commit. Keep refactors and features in separate commits.
- Reuse the canonical helper instead of copying code (`callAddon`, the tone-switch helpers,
  `desktop-config.ts`).
- Bug fixes come with a test that would have caught the bug.
- A bundled plugin that fails to clone now fails the build. Set `ALLOW_MISSING_PLUGINS=1`
  only for local or fork builds.
