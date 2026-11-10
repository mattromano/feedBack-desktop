// MIDI program-change mode must keep the chain on song load.
//
// In MIDI PC mode the song only sends program changes to a VST already in the
// chain. Song start asks songShouldRebuildChain() whether to clear the chain
// first; it used to say yes whenever the song's merged bypass mappings named a
// real preset, even though MIDI mode never uses them. The clear removed the
// VST the program changes go to (seen in the packaged app: getChainState()
// == [] after loading a MIDI-mode song). Regression test for that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `function ${name} not found`);
    let i = src.indexOf('{', src.indexOf(')', start)) + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    return src.slice(start, i);
}

const KEY = 'settings-v1-song';
const PRESETS = { Clean: { nativePreset: '{}' }, Lead: { nativePreset: '{}' } };

function decide({ mappings = {}, midiPC = {}, ta = null }) {
    const store = { 'slopsmith-tone-mappings': JSON.stringify({ global: {}, songs: { [KEY]: mappings }, midiPC }) };
    const ctx = {
        JSON, Object, String, Number,
        localStorage: { getItem: (k) => store[k] ?? null },
        getPresets: () => PRESETS,
        window: {
            _aeGetCurrentSongKey: () => KEY,
            _aeToneAutomation: ta ? { isEnabled: () => true, getConfig: () => ({ targets: ta }) } : undefined,
        },
    };
    vm.runInNewContext(`${extractFunction(SRC, 'songShouldRebuildChain')}; this.r = songShouldRebuildChain();`, ctx);
    return ctx.r;
}

const MIDI = { [KEY]: { mode: 'midi', vstSlotId: 40, channel: 1, mappings: { clean: 2, lead: 5 } } };

test('bypass mappings alone still rebuild the chain', () => {
    assert.equal(decide({ mappings: { clean: 'Clean', lead: 'Lead' } }), true);
});

test('MIDI PC mode keeps the chain even when bypass mappings exist', () => {
    assert.equal(decide({ mappings: { clean: 'Clean', lead: 'Lead' }, midiPC: MIDI }), false);
});

test('MIDI PC mode with no mappings keeps the chain', () => {
    assert.equal(decide({ midiPC: MIDI }), false);
});

test('an invalid MIDI entry (no slot) does not block a bypass rebuild', () => {
    const bad = { [KEY]: { mode: 'midi', vstSlotId: -1, mappings: {} } };
    assert.equal(decide({ mappings: { clean: 'Clean' }, midiPC: bad }), true);
});

test('Tone Automation still wins over MIDI mode (it rebuilds the chain itself)', () => {
    assert.equal(decide({ midiPC: MIDI, ta: { idle: 'Clean' } }), true);
});
