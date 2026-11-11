// Live Retune's "Shift my guitar" section in the core's guitar dropdown: picking
// what the guitar should sound as drives the engine's live pitch shift. Runs the
// real plugin script in a vm with a stub engine bridge, a stub v3Badges hook and a
// fake menu slot.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'live-retune', 'screen.js'), 'utf8');

function fakeSlot() {
    const els = {};
    return {
        innerHTML: '',
        els,
        querySelector(sel) {
            if (!this.innerHTML.includes(sel.replace(/^\[|\]$/g, ''))) return null;
            return els[sel] || (els[sel] = { handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } });
        },
    };
}

function run({ saved = {}, offsets = null, withHook = true } = {}) {
    const calls = [];
    const registered = [];
    const store = { liveRetune: JSON.stringify(saved) };
    const window = {
        feedBackDesktop: {
            audio: {
                setLivePitch: (p) => { calls.push(p); return Promise.resolve(); },
                getLivePitch: () => Promise.resolve({ supported: true, cents: 0, windowMs: 14, latencyMs: 0 }),
            },
        },
        feedBack: { workingTuning: { get: () => ({ stringCount: 6, offsets }) } },
        displayTuningName: (v, o) => ({
            '0,0,0,0,0,0': 'E Standard', '-1,-1,-1,-1,-1,-1': 'Eb Standard', '-2,-2,-2,-2,-2,-2': 'D Standard',
            '-2,0,0,0,0,0': 'Drop D', '-3,-1,-1,-1,-1,-1': 'Drop C#',
        })[o.join(',')] || 'Custom Tuning',
        highway: { getSongInfo: () => ({ tuning: [0, 0, 0, 0, 0, 0] }) },
        addEventListener: () => {},
    };
    if (withHook) window.v3Badges = { registerMenuSection: (id, render, opts) => { registered.push({ id, render, opts }); return true; } };
    const ctx = {
        window,
        document: { getElementById: () => null, createElement: () => ({}) },
        localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
        setInterval: () => 0,
        Promise,
    };
    vm.runInNewContext(SRC, ctx);
    return { window, lr: window.__liveRetune, calls, registered, last: () => calls[calls.length - 1] };
}

test('registers a "Shift my guitar" section ahead of other sections', () => {
    const { registered } = run();
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, 'live-retune-shift');
    assert.equal(registered[0].opts.order, 10);
});

test('queues the section when the core hook is not loaded yet', () => {
    const { window } = run({ withHook: false });
    assert.equal(window._v3BadgesPendingSections.length, 1);
    assert.equal(window._v3BadgesPendingSections[0].id, 'live-retune-shift');
});

test('"Sound as" names the shifted tuning from the guitar tuning', () => {
    const { lr } = run();
    assert.equal(lr.shiftedTuningName([0, 0, 0, 0, 0, 0], -2), 'D Standard');
    assert.equal(lr.shiftedTuningName([-2, 0, 0, 0, 0, 0], -1), 'Drop C#');
    assert.equal(lr.shiftedTuningName([0, 0, 0, 0, 0, 0], 3), '+3 st', 'unnamed shifts show the semitones');
});

test('picking a tuning in the menu shifts the guitar signal', () => {
    const { registered, last } = run();
    const slot = fakeSlot();
    let refreshed = 0;
    registered[0].render(slot, { refresh: () => { refreshed++; } });
    assert.match(slot.innerHTML, /Shift my guitar/);
    assert.match(slot.innerHTML, /<option value="-1">Eb Standard \(-1\)<\/option>/);
    slot.els['[data-lr-sound-as]'].handlers.change({ target: { value: '-1' } });
    assert.equal(last().semitones, -1, 'engine shifted down a semitone');
    assert.equal(refreshed, 1, 'menu redrawn');

    const again = fakeSlot();
    registered[0].render(again, { refresh: () => {} });
    assert.match(again.innerHTML, /Sounding as Eb Standard/);
    assert.match(again.innerHTML, /<option value="-1" selected>/);
    again.els['[data-lr-zero]'].handlers.click();
    assert.equal(last().semitones, 0, 'No shift goes back to 0');
});

test('the −/+ buttons step a semitone and Follow song toggles', () => {
    const { registered, last, lr } = run();
    const slot = fakeSlot();
    registered[0].render(slot, { refresh: () => {} });
    slot.els['[data-lr-down]'].handlers.click();
    assert.equal(last().semitones, -1);
    slot.els['[data-lr-up]'].handlers.click();
    assert.equal(last().semitones, 0);
    slot.els['[data-lr-follow]'].handlers.click();
    assert.equal(lr.state.follow, true);
});
