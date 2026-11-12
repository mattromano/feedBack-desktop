// Top tones in the core's instrument menu: starred presets first, then the
// most-loaded ones. Pins the ordering, the use counting, the delete scrub and
// the registration with the core's v3Badges.registerMenuSection hook.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const SCREEN_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8');

function extractFunction(src, name) {
    const start = src.search(new RegExp(`(async )?function ${name}\\(`));
    assert.ok(start !== -1, `function '${name}' not found`);
    let i = src.indexOf('{', src.indexOf(')', start)) + 1;
    let depth = 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    return src.slice(start, i);
}

function harness(presets, { loadOk = true, transitioning = false } = {}) {
    const store = {};
    const loads = [];
    const locked = [];
    const ctx = {
        isSongTransitioning: () => transitioning,
        withToneChainLock: (job) => { locked.push(true); return job(); },
        locked,
        console: { log() {}, warn() {} },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        getPresets: () => presets,
        replaceChainWithPresetBlob: async (p, tag) => { loads.push(tag); return loadOk; },
    };
    const code = [
        "const PRESET_STARS_KEY = 'slopsmith-preset-stars';",
        "const PRESET_USES_KEY = 'slopsmith-preset-use-counts';",
        ...['readPresetStars', 'writePresetStars', 'readPresetUses', 'writePresetUses',
            'togglePresetStar', 'recordPresetUse', 'forgetPresetStats', 'topTonePresetNames',
            'loadPresetManually', 'presetUseScores'].map((n) => extractFunction(SCREEN_JS, n)),
        'Object.assign(this, { readPresetStars, readPresetUses, togglePresetStar, recordPresetUse, forgetPresetStats, topTonePresetNames, loadPresetManually, presetUseScores });',
    ].join('\n');
    vm.runInNewContext(code, ctx);
    return { ctx, store, loads };
}

const PRESETS = { 'Main Lead': {}, 'Black Parade Lead': {}, Clean: {}, Crunch: {} };
const arr = (a) => Array.from(a);

test('starred presets come first, in star order, then most used', () => {
    const { ctx } = harness(PRESETS);
    const names = ctx.topTonePresetNames(PRESETS, ['Clean', 'Main Lead'], { Crunch: 2, 'Black Parade Lead': 9, 'Main Lead': 50 }, 5);
    assert.deepEqual(arr(names), ['Clean', 'Main Lead', 'Black Parade Lead', 'Crunch']);
});

test('drops deleted presets, unused ones, and respects the limit', () => {
    const { ctx } = harness(PRESETS);
    assert.deepEqual(arr(ctx.topTonePresetNames(PRESETS, ['Gone'], { Gone: 5, Clean: 0, Crunch: 1 }, 5)), ['Crunch']);
    assert.deepEqual(arr(ctx.topTonePresetNames(PRESETS, [], { Clean: 1, Crunch: 1, 'Main Lead': 1 }, 2)), ['Clean', 'Crunch'], 'ties sort by name');
});

test('with nothing starred or counted yet, tone history fills the list', () => {
    const { ctx } = harness(PRESETS);
    // Fresh install of the feature: no stars, no counts — but songs already have
    // whole-song tone locks and Tone Automation targets presets.
    const locks = { 'song-a': 'Black Parade Lead', 'song-b': 'Black Parade Lead', 'song-c': 'Main Lead' };
    const ta = { od: 'Main Lead', dist: 'Main Lead', clean: 'Clean' };
    const scores = ctx.presetUseScores({}, locks, ta);
    assert.deepEqual(arr(ctx.topTonePresetNames(PRESETS, [], scores, 5)), ['Main Lead', 'Black Parade Lead', 'Clean']);
    // Counted loads add on top of history.
    assert.equal(ctx.presetUseScores({ Crunch: 4 }, locks, ta).Crunch, 4);
    assert.deepEqual(Object.keys(ctx.presetUseScores(null, null, null)), []);
    assert.equal(ctx.presetUseScores({}, {}, { bass: 'Crunch' }).Crunch, undefined, 'the bass-arrangement slot is not a guitar tone');
});

test('the menu ranks with tone history, not counted loads alone', () => {
    assert.match(extractFunction(SCREEN_JS, 'renderInstMenuTopTones'),
        /presetUseScores\(readPresetUses\(\), readSongToneLocks\(\), \(readTaStore\(\) \|\| \{\}\)\.targets\)/);
});

test('star toggles on and off', () => {
    const { ctx } = harness(PRESETS);
    assert.equal(ctx.togglePresetStar('Clean'), true);
    assert.deepEqual(arr(ctx.readPresetStars()), ['Clean']);
    assert.equal(ctx.togglePresetStar('Clean'), false);
    assert.deepEqual(arr(ctx.readPresetStars()), []);
});

test('a manual load counts a use; a failed one does not', async () => {
    const ok = harness(PRESETS);
    assert.equal(await ok.ctx.loadPresetManually('Main Lead', 'inst-menu'), true);
    assert.deepEqual(ok.loads, ['inst-menu:Main Lead']);
    assert.equal(ok.ctx.locked.length, 1, 'the load runs under the tone chain lock');
    assert.equal(ok.ctx.readPresetUses()['Main Lead'], 1);

    const mid = harness(PRESETS, { transitioning: true });
    assert.equal(await mid.ctx.loadPresetManually('Main Lead', 'inst-menu'), false, 'no manual load during a song load');
    assert.deepEqual(mid.loads, []);

    const bad = harness(PRESETS, { loadOk: false });
    assert.equal(await bad.ctx.loadPresetManually('Main Lead', 'inst-menu'), false);
    assert.equal(bad.ctx.readPresetUses()['Main Lead'], undefined);
    assert.equal(await bad.ctx.loadPresetManually('Nope', 'inst-menu'), false);
});

test('deleting a preset forgets its star and count', () => {
    const { ctx } = harness(PRESETS);
    ctx.togglePresetStar('Clean');
    ctx.recordPresetUse('Clean');
    ctx.recordPresetUse('Crunch');
    ctx.forgetPresetStats('Clean');
    assert.deepEqual(arr(ctx.readPresetStars()), []);
    assert.deepEqual(Object.keys(ctx.readPresetUses()), ['Crunch']);
});

test('corrupt storage reads as empty', () => {
    const { ctx, store } = harness(PRESETS);
    store['slopsmith-preset-stars'] = '{oops';
    store['slopsmith-preset-use-counts'] = '[1,2]';
    assert.deepEqual(arr(ctx.readPresetStars()), []);
    assert.deepEqual(Object.keys(ctx.readPresetUses()), []);
});

test('wiring: Settings Load and tone automation count uses; delete scrubs; section registers', () => {
    assert.match(SCREEN_JS, /data-action="load"\]'\)\.addEventListener\('click', async \(\) => \{\s*await loadPresetManually\(name, 'settings-load'\);/);
    assert.match(extractFunction(SCREEN_JS, 'loadPresetByName'), /recordPresetUse\(presetName\)/);
    assert.match(SCREEN_JS, /forgetPresetStats\(name\);\s*renderPresetList\(\);/);
    assert.doesNotMatch(extractFunction(SCREEN_JS, 'loadDefaultPreset'), /recordPresetUse/, 'startup default load is not a use');
    assert.match(SCREEN_JS, /registerMenuSection\(section\.id, section\.render, section\)/);
    assert.match(SCREEN_JS, /id: 'audio-engine-top-tones', render: renderInstMenuTopTones, order: 20/, 'top tones sit below the guitar shift');
    assert.match(SCREEN_JS, /_v3BadgesPendingSections\.push\(section\)/);
});
