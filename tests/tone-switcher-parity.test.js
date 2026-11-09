// Untangler safety net for I-003 (one tone-switcher factory shared by both
// screen.js IIFEs).
//
// Today the bypass switcher exists twice (IIFE 1's ToneSwitcher class and an
// object literal in IIFE 2's song preload) and the MIDI program-change
// switcher three times. These tests run every copy against the same scripted
// tone sequence with a fake audio API and require identical engine calls, so
// collapsing them into one factory cannot change what reaches the engine.
// The preload race (IIFE 2 not serialised by _applyToneMappingsLock) is not
// unit-testable here; it is covered by the packaged-build checklist in
// .untangler/audit.json (I-003 safety_net.manual_checks).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8').replace(/\r\n/g, '\n');

function braceBlock(src, openIdx) {
    let i = openIdx + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    return src.slice(openIdx, i);
}
function extractDecl(src, head) {
    const start = src.indexOf(head);
    assert.ok(start !== -1, `${head} not found`);
    const open = head.startsWith('class ') ? src.indexOf('{', start) : src.indexOf('{', src.indexOf(')', start));
    return src.slice(start, open) + braceBlock(src, open);
}
// The object literal assigned to window._toneSwitcher at the first assignment
// after `anchor`.
function switcherLiteral(anchor) {
    const a = SRC.indexOf(anchor);
    assert.ok(a !== -1, `anchor not found: ${anchor}`);
    const assign = SRC.indexOf('window._toneSwitcher = {', a);
    assert.ok(assign !== -1 && assign - a < 2000, `no switcher literal near: ${anchor}`);
    return braceBlock(SRC, SRC.indexOf('{', assign));
}

// ── Shared fixture ──────────────────────────────────────────────────────────
const PRESETS = {
    CleanP: {
        items: [{ type: 'NAM', path: 'a.nam' }, { type: 'VST', path: 'v.vst3' }],
        nativePreset: JSON.stringify({ chain: [{ type: 1, path: 'a.nam' }, { type: 0, path: 'v.vst3', state: 'S1' }] }),
    },
    LeadP: {
        items: [{ type: 'VST', path: 'w.vst3' }],
        nativePreset: JSON.stringify({ chain: [{ type: 0, path: 'w.vst3', state: 'S2' }] }),
    },
};
const MAPPINGS = { Clean: 'CleanP', Lead: 'LeadP' };
const TONE_CHANGES = [{ name: 'Lead', time: 10 }, { name: 'Clean', time: 20 }];
const TONE_BASE = 'Clean';
const SEQUENCE = ['Lead', 'Lead', 'Nope', 'Clean'];

function fakeApi(log) {
    let next = 1;
    const rec = (name, ret) => (...a) => { log.push([name, ...a]); return typeof ret === 'function' ? ret() : ret; };
    return {
        clearChain: rec('clearChain', undefined),
        loadNAMModel: rec('loadNAMModel', () => next++),
        loadIR: rec('loadIR', () => next++),
        loadVST: rec('loadVST', () => next++),
        setSlotState: rec('setSlotState', true),
        setMultiBypass: rec('setMultiBypass', undefined),
        sendMidiToSlot: rec('sendMidiToSlot', undefined),
    };
}
const quiet = { log() {}, warn() {}, error() {} };
// Values built inside the vm realm have foreign prototypes; compare as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ── Bypass switcher ─────────────────────────────────────────────────────────
test('IIFE 1 ToneSwitcher: preload and switch call the engine as pinned', async () => {
    const log = [];
    const ctx = {
        console: quiet,
        localStorage: { setItem() {} },
        api: fakeApi(log),
        getPresets: () => PRESETS,
        resolveTonePresetName: (m, n) => m[n] || m.$default,
        aeIsRigBuilderStage: () => false,
        applyPresetGainLevels: (p) => log.push(['gain', p === PRESETS.CleanP ? 'CleanP' : 'LeadP']),
        applyPresetNoiseGate: () => log.push(['gate']),
        applyPresetTonePolish: () => log.push(['polish']),
        refreshChain: async () => log.push(['refreshChain']),
        chainContainer: null,
        $: () => null,
    };
    vm.runInNewContext([
        extractDecl(SRC, 'function getPresetItems('),
        extractDecl(SRC, 'function getToneChangeTime('),
        extractDecl(SRC, 'async function loadPresetItemsWithState('),
        extractDecl(SRC, 'class ToneSwitcher'),
        'this.ToneSwitcher = ToneSwitcher;',
    ].join('\n'), ctx);

    const sw = new ctx.ToneSwitcher();
    await sw.preloadForSong(TONE_CHANGES, TONE_BASE, MAPPINGS);
    assert.deepEqual(plain(log.splice(0)), [
        ['clearChain'],
        ['loadNAMModel', 'a.nam'],
        ['loadVST', 'v.vst3'],
        ['setSlotState', 2, 'S1'],
        ['loadVST', 'w.vst3'],
        ['setSlotState', 3, 'S2'],
        ['setMultiBypass', [{ slotId: 3, bypassed: true }]],
        ['gain', 'CleanP'], ['gate'], ['polish'],
        ['refreshChain'],
    ]);
    assert.deepEqual(plain(sw.toneSlotMap), { Clean: [1, 2], Lead: [3] });
    assert.deepEqual(plain(sw.tonePresetNameMap), { Clean: 'CleanP', Lead: 'LeadP' });
    assert.equal(sw.activeTone, 'Clean');

    for (const t of SEQUENCE) sw.switchToTone(t);
    assert.deepEqual(plain(log), BYPASS_SWITCH_CALLS);
});

const BYPASS_SWITCH_CALLS = [
    ['setMultiBypass', [{ slotId: 1, bypassed: true }, { slotId: 2, bypassed: true }, { slotId: 3, bypassed: false }]],
    ['gain', 'LeadP'], ['gate'], ['polish'],
    ['setMultiBypass', [{ slotId: 3, bypassed: true }, { slotId: 1, bypassed: false }, { slotId: 2, bypassed: false }]],
    ['gain', 'CleanP'], ['gate'], ['polish'],
];

test('IIFE 2 bypass switcher switches exactly like IIFE 1', () => {
    const log = [];
    const ctx = {
        console: quiet,
        api: fakeApi(log),
        effectiveBase: 'Clean',
        toneSlotMap: { Clean: [1, 2], Lead: [3] },
        tonePresetMap: { Clean: PRESETS.CleanP, Lead: PRESETS.LeadP },
        applyPresetGainLevels: (_api, p) => log.push(['gain', p === PRESETS.CleanP ? 'CleanP' : 'LeadP']),
        applyPresetNoiseGate: () => log.push(['gate']),
        applyPresetTonePolish: () => log.push(['polish']),
    };
    vm.runInNewContext(`this.sw = ${switcherLiteral('const initialPreset = tonePresetMap[effectiveBase];')};`, ctx);
    for (const t of SEQUENCE) ctx.sw.switchToTone(t);
    assert.deepEqual(plain(log), BYPASS_SWITCH_CALLS);
    // Known drift (I-003): this copy has no tonePresetNameMap, so the chain
    // panel's preset-name lookup misses for bypass songs loaded via IIFE 2.
    assert.equal(ctx.sw.tonePresetNameMap, undefined);
});

// ── MIDI program-change switcher (three copies) ─────────────────────────────
const MIDI = { mode: 'midi', vstSlotId: 7, channel: 2, mappings: { Clean: 1, Lead: 5 } };
const MIDI_COPIES = {
    'IIFE 1 song load': 'const midiMappings = midiConfig.mappings || {};\n                toneSwitcher = null;',
    'IIFE 1 Save MIDI Mapping': 'const _midiCh = chInput ? parseInt(chInput.value) : 1;',
    'IIFE 2 song preload': '// MIDI PC mode — send program changes to a single VST',
};

for (const [label, anchor] of Object.entries(MIDI_COPIES)) {
    test(`MIDI switcher (${label}) sends the same program changes`, () => {
        const log = [];
        const api = fakeApi(log);
        const ctx = {
            console: quiet,
            window: { feedBackDesktop: { audio: api } },
            api, midiConfig: MIDI, midiMappings: MIDI.mappings,
            _liveApi: api, _midiMappings: MIDI.mappings, _midiVstSlot: MIDI.vstSlotId, _midiCh: MIDI.channel,
        };
        vm.runInNewContext(`this.sw = ${switcherLiteral(anchor)};`, ctx);
        assert.equal(ctx.sw.midiMode, true);
        for (const t of ['Clean', 'Clean', 'Nope', 'Lead', 'Lead']) ctx.sw.switchToTone(t);
        assert.deepEqual(log, [
            ['sendMidiToSlot', 7, 0, 2, 1],
            ['sendMidiToSlot', 7, 0, 2, 5],
        ]);
        assert.equal(ctx.sw.activeTone, 'Lead');
    });
}
