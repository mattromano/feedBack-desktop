// Untangler safety net for I-004 (callAddon helper in audio-bridge.ts).
//
// Registers every audio:* IPC handler against a stubbed electron and a fake
// native addon, calls each one, and compares what it returns (and what it
// logs) with a committed snapshot. Three addon states are covered:
//   missing  - the .node file cannot be loaded (audio === null)
//   throws   - init() works, every other export throws
//   returns  - every export returns a tagged value
// Folding the ~40 copies of "if (!audio) return X; try {...} catch {warn}"
// into one helper must leave this snapshot byte-identical.
//
// Regenerate (only when a behaviour change is intended):
//   UPDATE_SNAPSHOT=1 node --test tests/audio-bridge-fallbacks.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTsStubbed, ROOT } = require('./_load-ts-stubbed');

const SNAPSHOT = path.join(__dirname, 'fixtures', 'audio-bridge-fallbacks.snapshot.json');
// Fixed argument list handed to every handler after the event.
const ARGS = [0, 'x', 0];

function fakeAddon(mode) {
    return new Proxy({}, {
        get(_t, name) {
            if (typeof name !== 'string' || name === 'then') return undefined;
            if (name === 'init') return () => undefined;
            if (mode === 'throws') return () => { throw new Error(`boom:${name}`); };
            return (...a) => `ret:${name}:${a.length}`;
        },
        has() { return true; },
    });
}

function settle(value) {
    if (!value || typeof value.then !== 'function') return Promise.resolve({ ret: value });
    return Promise.race([
        value.then((ret) => ({ ret }), (e) => ({ rejected: String(e && e.message) })),
        new Promise((r) => setTimeout(() => r({ pending: true }), 100)),
    ]);
}

function normalize(value, tmp) {
    const s = JSON.stringify(value === undefined ? null : value, (_k, v) => {
        if (v === undefined) return '<undefined>';
        if (typeof v === 'number' && !Number.isFinite(v)) return `<${v}>`;
        if (typeof v === 'function') return '<function>';
        return v;
    });
    return JSON.parse(
        s.split(tmp.replace(/\\/g, '\\\\')).join('<TMP>')
            .split(tmp).join('<TMP>')
            .split(ROOT.replace(/\\/g, '\\\\')).join('<ROOT>')
            .split(ROOT).join('<ROOT>'),
    );
}

async function runScenario(mode) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `untangler-i004-${mode}-`));
    const handlers = new Map();
    const reg = (kind) => (channel, fn) => handlers.set(channel, { kind, fn });
    const electron = {
        ipcMain: { handle: reg('handle'), on: reg('on') },
        app: { getPath: () => tmp, isPackaged: false },
    };
    const stubs = {
        electron,
        './debug-log': { isDebugEnabled: () => false, getDebugLogPath: () => path.join(tmp, 'debug.log') },
        './vst-crash-guard': {
            initVstCrashGuard: () => [],
            armSentinel() {}, disarmSentinel() {}, armEditorSentinel() {},
            getSentinelPath: () => path.join(tmp, 'sentinel'),
        },
    };
    const addon = mode === 'missing' ? null : fakeAddon(mode);
    const resolveExtra = (id) => {
        if (!id.endsWith('slopsmith_audio.node')) return undefined;
        if (!addon) throw new Error('not found');
        return addon;
    };

    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {};
    console.warn = (...a) => logs.push(['warn', a.map(String).join(' ')]);
    console.error = (...a) => logs.push(['error', a.map(String).join(' ')]);
    const out = {};
    try {
        const bridge = loadTsStubbed('src/main/audio-bridge.ts', stubs, resolveExtra);
        bridge.initAudioBridge();
        logs.length = 0;
        for (const channel of [...handlers.keys()].sort()) {
            const { kind, fn } = handlers.get(channel);
            let result;
            try {
                result = await settle(fn({ sender: { send() {} } }, ...ARGS));
            } catch (e) {
                result = { threw: String(e && e.message) };
            }
            out[channel] = normalize({ kind, ...result, logs: logs.splice(0) }, tmp);
        }
    } finally {
        Object.assign(console, orig);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return out;
}

test('audio-bridge handler fallbacks match the snapshot', async () => {
    const actual = {};
    for (const mode of ['missing', 'throws', 'returns']) actual[mode] = await runScenario(mode);

    if (process.env.UPDATE_SNAPSHOT === '1' || !fs.existsSync(SNAPSHOT)) {
        fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
        fs.writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n');
    }
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    assert.equal(Object.keys(actual.missing).length, 114, 'handler count changed');
    for (const mode of Object.keys(expected)) {
        for (const channel of Object.keys(expected[mode])) {
            assert.deepEqual(actual[mode][channel], expected[mode][channel], `${mode} ${channel}`);
        }
        assert.deepEqual(Object.keys(actual[mode]), Object.keys(expected[mode]), `${mode} channel set`);
    }
});
