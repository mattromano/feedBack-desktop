// Backing-track pitch transpose (setBackingPitch / getBackingPitch /
// getBackingLatencyMs). Two layers:
//   1. The audio-bridge IPC handlers, lifted out of audio-bridge.ts and run
//      against a fake native module — same fail-soft contract as
//      audio:setBackingSpeed (false on downlevel addon / invalid value / throw).
//   2. The real addon (auto-skips unless build/Release/slopsmith_audio.node
//      exists): engine-side sanitizing — clamp to ±12, whole cents, non-finite
//      ignored, non-number rejected — and zero latency while bypassed.
// The DSP itself (transpose accuracy, latency model) is pinned by the C++
// tests/engine_units/backing_stretch_test.cpp.
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
    const sig = `ipcMain.handle('${channel}',`;
    const start = src.indexOf(sig);
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

const CHANNELS = ['audio:setBackingPitch', 'audio:getBackingPitch', 'audio:getBackingLatencyMs'];

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
    let pitch = 0;
    return {
        calls,
        setBackingPitch(semitones) { calls.push(semitones); pitch = semitones; },
        getBackingPitch() { return pitch; },
        getBackingLatencyMs() { return pitch === 0 ? 0 : 120; },
    };
}

test('setBackingPitch forwards finite semitones (incl. cents) and resolves true', () => {
    const addon = fakeAddon();
    const { handlers } = loadHandlers(addon);
    assert.equal(handlers['audio:setBackingPitch']({}, -1), true);
    assert.equal(handlers['audio:setBackingPitch']({}, -0.17), true);
    assert.equal(handlers['audio:setBackingPitch']({}, 0), true);
    assert.deepEqual(addon.calls, [-1, -0.17, 0]);
});

test('setBackingPitch rejects non-finite / non-number without calling native', () => {
    const addon = fakeAddon();
    const { handlers } = loadHandlers(addon);
    for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined, {}]) {
        assert.equal(handlers['audio:setBackingPitch']({}, bad), false, `value ${String(bad)}`);
    }
    assert.deepEqual(addon.calls, []);
});

test('setBackingPitch is fail-soft on a downlevel addon, no addon, or a native throw', () => {
    assert.equal(loadHandlers({}).handlers['audio:setBackingPitch']({}, 1), false);
    assert.equal(loadHandlers(null).handlers['audio:setBackingPitch']({}, 1), false);
    const { handlers, warnings } = loadHandlers({ setBackingPitch() { throw new Error('boom'); } });
    assert.equal(handlers['audio:setBackingPitch']({}, 1), false);
    assert.match(warnings.join('\n'), /setBackingPitch failed: boom/);
});

test('getBackingPitch / getBackingLatencyMs read through, 0 when unsupported', () => {
    const addon = fakeAddon();
    const { handlers } = loadHandlers(addon);
    handlers['audio:setBackingPitch']({}, -2);
    assert.equal(handlers['audio:getBackingPitch'](), -2);
    assert.equal(handlers['audio:getBackingLatencyMs'](), 120);
    for (const downlevel of [{}, null]) {
        const h = loadHandlers(downlevel).handlers;
        assert.equal(h['audio:getBackingPitch'](), 0);
        assert.equal(h['audio:getBackingLatencyMs'](), 0);
    }
});

const ADDON = path.join(ROOT, 'build', 'Release', 'slopsmith_audio.node');
const HAVE_ADDON = fs.existsSync(ADDON);

test('native setBackingPitch sanitizes engine-side', { skip: !HAVE_ADDON && 'addon not built' }, () => {
    const audio = require(ADDON);
    audio.init();
    try {
        assert.equal(audio.getBackingPitch(), 0);
        assert.equal(audio.getBackingLatencyMs(), 0);

        audio.setBackingPitch(-1);
        assert.equal(audio.getBackingPitch(), -1);
        audio.setBackingPitch(-0.1749); // rounds to whole cents
        assert.ok(Math.abs(audio.getBackingPitch() - -0.17) < 1e-9);
        audio.setBackingPitch(40); // clamps to +12
        assert.equal(audio.getBackingPitch(), 12);
        audio.setBackingPitch(-40);
        assert.equal(audio.getBackingPitch(), -12);

        // Non-finite is ignored (keeps the last value); non-number throws.
        audio.setBackingPitch(NaN);
        audio.setBackingPitch(Infinity);
        assert.equal(audio.getBackingPitch(), -12);
        assert.throws(() => audio.setBackingPitch('x'), TypeError);
        assert.throws(() => audio.setBackingPitch(), TypeError);

        // No device running → no sample rate → no latency to report.
        assert.equal(audio.getBackingLatencyMs(), 0);

        audio.setBackingPitch(0.004); // sub-cent → bypass
        assert.equal(audio.getBackingPitch(), 0);
    } finally {
        audio.setBackingPitch(0);
        audio.shutdown?.();
    }
});
