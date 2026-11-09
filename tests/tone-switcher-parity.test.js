// Untangler safety net for I-003 (one tone-switch implementation shared by
// both screen.js IIFEs).
//
// Bypass switchers are installed in two places (IIFE 1's ToneSwitcher class and
// IIFE 2's song preload) and MIDI program-change switchers in three. Each
// install site is run against the same scripted tone sequence with a fake
// audio API and must make identical engine calls. The chain lock that
// serialises IIFE 2's preload with tone-mapping applies is tested directly;
// the real-app timing is covered by the packaged-build checklist in
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
function parenBlock(src, openIdx) {
    let i = openIdx + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
    return src.slice(openIdx, i);
}
// The expression (object literal or call) assigned to window._toneSwitcher at
// the first assignment after `anchor`.
function switcherExpr(anchor) {
    const a = SRC.indexOf(anchor);
    assert.ok(a !== -1, `anchor not found: ${anchor}`);
    const marker = 'window._toneSwitcher = ';
    const assign = SRC.indexOf(marker, a);
    assert.ok(assign !== -1 && assign - a < 2000, `no switcher install near: ${anchor}`);
    const at = assign + marker.length;
    if (SRC[at] === '{') return braceBlock(SRC, at);
    const open = SRC.indexOf('(', at);
    return SRC.slice(at, open) + parenBlock(SRC, open);
}
const SHARED = [
    extractDecl(SRC, 'function bypassSwitchToTone('),
    extractDecl(SRC, 'function makeMidiToneSwitcher('),
].join('\n');

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
        SHARED,
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
        window: {},
        api: fakeApi(log),
        effectiveBase: 'Clean',
        toneSlotMap: { Clean: [1, 2], Lead: [3] },
        tonePresetMap: { Clean: PRESETS.CleanP, Lead: PRESETS.LeadP },
        tonePresetNameMap: { Clean: 'CleanP', Lead: 'LeadP' },
        applyPresetGainLevels: (_api, p) => log.push(['gain', p === PRESETS.CleanP ? 'CleanP' : 'LeadP']),
        applyPresetNoiseGate: () => log.push(['gate']),
        applyPresetTonePolish: () => log.push(['polish']),
    };
    vm.runInNewContext(`${SHARED}
window._aeBypassSwitchToTone = bypassSwitchToTone;
this.sw = ${switcherExpr('const initialPreset = tonePresetMap[effectiveBase];')};`, ctx);
    for (const t of SEQUENCE) ctx.sw.switchToTone(t);
    assert.deepEqual(plain(log), BYPASS_SWITCH_CALLS);
    // Fixed drift: the chain panel's preset-name lookup now works for bypass
    // songs loaded via IIFE 2 too.
    assert.deepEqual(plain(ctx.sw.tonePresetNameMap), { Clean: 'CleanP', Lead: 'LeadP' });
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
        vm.runInNewContext(`${SHARED}
window._aeMakeMidiToneSwitcher = makeMidiToneSwitcher;
this.sw = ${switcherExpr(anchor)};`, ctx);
        assert.equal(ctx.sw.midiMode, true);
        for (const t of ['Clean', 'Clean', 'Nope', 'Lead', 'Lead']) ctx.sw.switchToTone(t);
        assert.deepEqual(log, [
            ['sendMidiToSlot', 7, 0, 2, 1],
            ['sendMidiToSlot', 7, 0, 2, 5],
        ]);
        assert.equal(ctx.sw.activeTone, 'Lead');
    });
}

// ── Chain lock shared by tone-mapping applies and IIFE 2's preload ─────────
test('withToneChainLock runs jobs one at a time, in order, past failures', async () => {
    const ctx = { window: {}, Promise };
    vm.runInNewContext(`let _applyToneMappingsLock = Promise.resolve();
${extractDecl(SRC, 'function withToneChainLock(')}
this.lock = withToneChainLock;`, ctx);
    const order = [];
    let running = 0;
    const job = (name, fail) => async () => {
        running++;
        assert.equal(running, 1, `${name} overlapped another job`);
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${name}:end`);
        running--;
        if (fail) throw new Error(name);
    };
    const a = ctx.lock(job('a'));
    const b = ctx.lock(job('b', true));
    const c = ctx.lock(job('c'));
    await a;
    await assert.rejects(b, /b/);
    await c;
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('tone-mapping applies and the IIFE 2 song preload share that lock', () => {
    assert.match(SRC, /function applyToneMappingsNow\(songKey, options = \{\}\) \{\n\s*return withToneChainLock\(/);
    assert.match(SRC, /window\._aeWithToneChainLock = withToneChainLock;/);
    const preloadAt = SRC.indexOf('const preload = async () => {');
    assert.ok(preloadAt !== -1, 'IIFE 2 preload not found');
    const tail = SRC.slice(preloadAt, SRC.indexOf('}, 800);', preloadAt));
    assert.match(tail, /const lock = window\._aeWithToneChainLock;\n\s*void \(typeof lock === 'function' \? lock\(preload\) : preload\(\)\);\s*$/);
    // After waiting for the lock, a newer song must win.
    assert.match(tail, /^const preload = async \(\) => \{\n(?:\s*\/\/.*\n)*\s*if \(hookState\.toneAutoLoadGeneration !== generation\) return;/);
});
