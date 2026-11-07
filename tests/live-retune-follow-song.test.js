// Live Retune "Follow song": an E-standard guitar is shifted by the song's tuning when every
// string is offset by the same whole number of semitones (Eb standard -> -1 st). Runs the real
// plugin script in a vm with a stub engine bridge and highway.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'live-retune', 'screen.js'), 'utf8');

function run({ saved = {}, tuning = [0, 0, 0, 0, 0, 0] } = {}) {
    const calls = [];
    const store = { liveRetune: JSON.stringify(saved) };
    const song = { tuning };
    const window = {
        feedBackDesktop: {
            audio: {
                setLivePitch: (p) => { calls.push(p); return Promise.resolve(); },
                getLivePitch: () => Promise.resolve({ supported: true, cents: 0, windowMs: 14, latencyMs: 0 }),
            },
        },
        highway: { getSongInfo: () => song },
        addEventListener: () => {},
    };
    const ctx = {
        window,
        document: { getElementById: () => null, createElement: () => ({}) },
        localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
        setInterval: () => 0,
        Promise,
    };
    vm.runInNewContext(SRC, ctx);
    const lr = window.__liveRetune;
    return { lr, calls, song, store, last: () => calls[calls.length - 1] };
}

test('only whole-guitar tunings are followed', () => {
    const { lr } = run();
    assert.equal(lr.songTuningSt([-1, -1, -1, -1, -1, -1]), -1, 'Eb standard');
    assert.equal(lr.songTuningSt([-2, -2, -2, -2, -2, -2]), -2, 'D standard');
    assert.equal(lr.songTuningSt([1, 1, 1, 1]), 1, 'up-tuned bass');
    assert.equal(lr.songTuningSt([-2, 0, 0, 0, 0, 0]), 0, 'Drop D is left alone');
    assert.equal(lr.songTuningSt([0, 0, 0, 0, 0, 0]), 0, 'E standard');
    assert.equal(lr.songTuningSt([-7, -7, -7, -7, -7, -7]), -5, 'clamped to the engine range');
    assert.equal(lr.songTuningSt(null), 0);
});

test('Follow song shifts an E-standard guitar to an Eb-standard song', () => {
    const { calls, last } = run({ saved: { follow: true }, tuning: [-1, -1, -1, -1, -1, -1] });
    assert.ok(calls.length > 0, 'applied on load');
    assert.equal(last().semitones, -1);
});

test('Follow off (the default) never shifts', () => {
    const { last } = run({ saved: {}, tuning: [-1, -1, -1, -1, -1, -1] });
    assert.equal(last().semitones, 0);
});

test('manual semitones stack on the followed tuning', () => {
    const { lr, last } = run({ saved: { follow: true, semitones: -1 }, tuning: [-1, -1, -1, -1, -1, -1] });
    assert.equal(last().semitones, -2);
    lr.set({ semitones: 0 });
    assert.equal(last().semitones, -1);
});

test('a new song re-reads the tuning', () => {
    const { lr, song, last } = run({ saved: { follow: true }, tuning: [-1, -1, -1, -1, -1, -1] });
    assert.equal(last().semitones, -1);
    song.tuning = [-2, -2, -2, -2, -2, -2];
    lr.apply();
    assert.equal(last().semitones, -2);
    song.tuning = [-2, 0, 0, 0, 0, 0];   // Drop D
    lr.apply();
    assert.equal(last().semitones, 0);
});

test('the choice is remembered', () => {
    const { lr, store } = run({ saved: {} });
    lr.set({ follow: true });
    assert.equal(JSON.parse(store.liveRetune).follow, true);
});
