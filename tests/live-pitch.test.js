// Live Retune IPC (audio:setLivePitch / audio:getLivePitch). Two layers:
//   1. The audio-bridge handlers, lifted out of audio-bridge.ts and run against
//      a fake native module: fail-soft (false / supported:false on a downlevel
//      addon, a malformed payload or a native throw, never a rejection).
//   2. The real addon (auto-skips unless build/Release/slopsmith_audio.node
//      exists): engine-side clamping and the status shape.
// The DSP itself (pitch accuracy, bit-exact bypass, latency) is pinned by the
// C++ ctest tests/live_pitch.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'main', 'audio-bridge.ts'), 'utf8');

// Source text of one `ipcMain.handle('<channel>', …);` registration.
function extractHandle(src, channel) {
    const sigs = [`ipcMain.handle('${channel}',`, `ipcMain.handle(\n        '${channel}',`];
    let start = -1;
    for (const sig of sigs) {
        start = src.indexOf(sig);
        if (start !== -1) break;
    }
    if (start === -1) start = src.search(new RegExp(`ipcMain\\.handle\\(\\s*'${channel}',`));
    assert.ok(start !== -1, `handler '${channel}' not found`);
    let i = src.indexOf('(', start);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) break;
    }
    assert.equal(depth, 0, `unbalanced parens in '${channel}'`);
    return src.slice(start, i + 1) + ';';
}

const CHANNELS = ['audio:setLivePitch', 'audio:getLivePitch'];

function loadHandlers(audio) {
    const handlers = {};
    const code = ts.transpile(CHANNELS.map((c) => extractHandle(BRIDGE_SRC, c)).join('\n'), {
        target: ts.ScriptTarget.ES2022,
    });
    const warnings = [];
    vm.runInNewContext(code, {
        audio,
        ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
        console: { warn: (...a) => warnings.push(a.join(' ')) },
        Number,
        Error,
        String,
    });
    return { handlers, warnings };
}

function fakeAddon() {
    const calls = [];
    let state = { supported: true, cents: 0, windowMs: 14, ratio: 1, latencyMs: 0 };
    return {
        calls,
        setLivePitch(p) {
            calls.push(p);
            state = { ...state, cents: (p.semitones ?? 0) * 100 + (p.cents ?? 0), windowMs: p.windowMs ?? state.windowMs };
            return true;
        },
        getLivePitch() { return state; },
    };
}

test('setLivePitch forwards a clean payload and resolves true', () => {
    const addon = fakeAddon();
    const { handlers } = loadHandlers(addon);
    assert.equal(handlers['audio:setLivePitch']({}, { semitones: -1, cents: 45, windowMs: 8 }), true);
    assert.equal(handlers['audio:setLivePitch']({}, { cents: -17 }), true);
    assert.equal(handlers['audio:setLivePitch']({}, {}), true);
    assert.deepEqual(addon.calls.map((c) => ({ ...c })), [{ semitones: -1, cents: 45, windowMs: 8 }, { cents: -17 }, {}]);
    assert.equal(handlers['audio:getLivePitch']().cents, 0);
});

test('setLivePitch rejects malformed payloads without calling native', () => {
    const addon = fakeAddon();
    const { handlers } = loadHandlers(addon);
    for (const bad of [null, undefined, 3, 'x', { semitones: NaN }, { cents: Infinity }, { windowMs: '8' }, { semitones: null }]) {
        assert.equal(handlers['audio:setLivePitch']({}, bad), false, `payload ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(addon.calls, []);
});

test('fail-soft on a downlevel addon, no addon, or a native throw', () => {
    for (const downlevel of [{}, null]) {
        const h = loadHandlers(downlevel).handlers;
        assert.equal(h['audio:setLivePitch']({}, { semitones: -1 }), false);
        assert.deepEqual({ ...h['audio:getLivePitch']() }, { supported: false, cents: 0, windowMs: 0, ratio: 1, latencyMs: 0 });
    }
    const { handlers, warnings } = loadHandlers({
        setLivePitch() { throw new Error('boom'); },
        getLivePitch() { throw new Error('bang'); },
    });
    assert.equal(handlers['audio:setLivePitch']({}, { semitones: 1 }), false);
    assert.equal(handlers['audio:getLivePitch']().supported, false);
    assert.match(warnings.join('\n'), /setLivePitch failed: boom/);
    assert.match(warnings.join('\n'), /getLivePitch failed: bang/);
});

const ADDON = path.join(ROOT, 'build', 'Release', 'slopsmith_audio.node');
const HAVE_ADDON = fs.existsSync(ADDON);

test('native setLivePitch clamps engine-side and reports status', { skip: !HAVE_ADDON && 'addon not built' }, () => {
    const audio = require(ADDON);
    audio.init();
    try {
        let s = audio.getLivePitch();
        assert.equal(s.supported, true);
        assert.equal(s.cents, 0);
        assert.equal(s.ratio, 1);
        assert.equal(s.latencyMs, 0);

        assert.equal(audio.setLivePitch({ semitones: -1, cents: 45, windowMs: 8 }), true);
        s = audio.getLivePitch();
        assert.equal(s.cents, -55);
        assert.equal(s.windowMs, 8);

        // Total clamps to +/-500 cents; the window to 6..40 ms.
        audio.setLivePitch({ semitones: 9, windowMs: 1000 });
        s = audio.getLivePitch();
        assert.equal(s.cents, 500);
        assert.equal(s.windowMs, 40);
        audio.setLivePitch({ semitones: -9, windowMs: 1 });
        s = audio.getLivePitch();
        assert.equal(s.cents, -500);
        assert.equal(s.windowMs, 6);

        // Absent window keeps the current one; non-finite fields count as absent.
        audio.setLivePitch({ cents: 30, windowMs: NaN });
        s = audio.getLivePitch();
        assert.equal(s.cents, 30);
        assert.equal(s.windowMs, 6);

        // Non-object is a clean no-op.
        assert.equal(audio.setLivePitch(7), false);
        assert.equal(audio.setLivePitch(), false);
        assert.equal(audio.getLivePitch().cents, 30);

        // No device running, so nothing is shifting yet.
        assert.equal(audio.getLivePitch().ratio, 1);
        assert.equal(audio.getLivePitch().latencyMs, 0);
    } finally {
        audio.setLivePitch({ semitones: 0, cents: 0 });
        audio.shutdown?.();
    }
});
