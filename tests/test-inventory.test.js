// Untangler safety net for I-001 (split the suite into a fast lane and an
// engine lane). Pins the full set of node:test files so the move into
// tests/engine/ cannot silently drop one, and checks that every test outside
// the engine set stays engine-free (never loads build/Release/*.node), which is
// what makes the fast lane safe to run on any machine and in CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TESTS = __dirname;

// Tests that load the native engine (directly or via tests/contracts/extract.js).
const ENGINE = [
    'chain-mutation-storm', 'contract-check', 'live-pitch',
    'ml-note-detection', 'multi-source', 'napi-arg-fuzz',
];

// Every node:test file at the untangler baseline plus the Phase 2 safety nets.
const ALL = [
    'audio-bridge-fallbacks', 'audio-chain-persistence', 'audio-effects-executor', 'boundaries',
    'build-plugin-clone', 'build-macos-dylibs', 'chain-mutation-storm', 'config-bootstrap',
    'config-migrations', 'config-paths', 'config-reset', 'contract-check',
    'desktop-config', 'device-setup-lifecycle', 'engine-no-default-mic',
    'guitar-input-channel-default', 'heard-clock-wiring', 'input-source-selection-sync',
    'juce-exclusive-type-name', 'library-path-config', 'linux-update-decision',
    'live-pitch', 'live-retune-follow-song', 'midi-chain-preserve', 'ml-note-detection',
    'monitor-mute-suppression', 'multi-source', 'napi-arg-fuzz',
    'preset-swap-mute', 'renderer-capability-migration', 'renderer-iife-scope',
    'song-tone-lock', 'startup-missing-input', 'test-inventory', 'top-tones', 'live-retune-menu',
    'tone-automation-base-tone', 'tone-load-no-stall', 'tone-switcher-parity',
    'window-bounds',
];

function listTests(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (e.name === 'fixtures' || e.name === 'node_modules') continue;
            out.push(...listTests(path.join(dir, e.name), path.join(rel, e.name)));
        } else if (e.name.endsWith('.test.js')) {
            out.push({ name: e.name.replace(/\.test\.js$/, ''), file: path.join(dir, e.name) });
        }
    }
    return out;
}

const found = listTests(TESTS);

test('no node:test file was added, dropped or duplicated', () => {
    const names = found.map((t) => t.name).sort();
    assert.deepEqual(names, [...ALL].sort());
});

const loads = (src) => /'Release'/.test(src) || /require\(['"](\.\.?)\/contracts\/extract(\.js)?['"]\)/.test(src);

test('only the engine set loads the native addon', () => {
    const actual = found.filter((t) => t.name !== 'test-inventory' && loads(fs.readFileSync(t.file, 'utf8'))).map((t) => t.name).sort();
    assert.deepEqual(actual, [...ENGINE].sort());
});

test('engine tests live in tests/engine/, everything else is in the fast lane', () => {
    // npm run test:fast runs tests/*.test.js; npm run test:engine runs tests/engine/*.test.js.
    const engineDir = path.join(TESTS, 'engine');
    const inEngine = found.filter((t) => path.dirname(t.file) === engineDir).map((t) => t.name).sort();
    const inFast = found.filter((t) => path.dirname(t.file) === TESTS).map((t) => t.name);
    assert.deepEqual(inEngine, [...ENGINE].sort());
    assert.equal(inEngine.length + inFast.length, ALL.length, 'a test file sits outside both lanes');
});
