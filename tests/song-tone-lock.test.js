// Whole-song tone lock: one saved preset held for an entire song from the
// in-player Tone Switching panel, overriding Tone Automation / per-tone maps.

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

function harness(presets, { queue } = {}) {
    const store = {};
    const loads = [];
    const q = { on: !!queue };
    const ctx = {
        window: { feedBack: { playQueue: { active: () => q.on } } },
        console: { log() {} },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        getPresets: () => presets,
        loadPresetByName: async (n) => { loads.push(n); return true; },
    };
    const code = [
        "const SONG_TONE_LOCK_KEY = 'slopsmith-song-tone-lock';",
        'let _queueToneLock = null;',
        extractFunction(SCREEN_JS, 'playQueueActive'),
        extractFunction(SCREEN_JS, 'readSongToneLocks'),
        extractFunction(SCREEN_JS, 'getSongToneLock'),
        extractFunction(SCREEN_JS, 'setSongToneLock'),
        extractFunction(SCREEN_JS, 'applySongToneLock'),
        'this.get = getSongToneLock; this.set = setSongToneLock; this.apply = applySongToneLock;',
        'this.setQueueLock = (v) => { _queueToneLock = v; }; this.queueLock = () => _queueToneLock;',
    ].join('\n');
    vm.runInNewContext(code, ctx);
    return { ctx, store, loads, q };
}

const PRESETS = { 'Main Lead': {}, 'Auto · Lead (Mesa Mark V)': {} };

test('a lock is stored per song and read back', () => {
    const { ctx } = harness(PRESETS);
    assert.equal(ctx.get('song-a'), null);
    ctx.set('song-a', 'Main Lead');
    assert.equal(ctx.get('song-a'), 'Main Lead');
    assert.equal(ctx.get('song-b'), null, 'other songs are unaffected');
});

test('"Follow tone changes" clears the lock', () => {
    const { ctx } = harness(PRESETS);
    ctx.set('song-a', 'Main Lead');
    ctx.set('song-a', null);
    assert.equal(ctx.get('song-a'), null);
});

test('a lock on a deleted preset is ignored', () => {
    const { ctx } = harness(PRESETS);
    ctx.set('song-a', 'Gone Preset');
    assert.equal(ctx.get('song-a'), null);
});

test('corrupt storage reads as no locks', () => {
    const { ctx, store } = harness(PRESETS);
    store['slopsmith-song-tone-lock'] = '{not json';
    assert.equal(ctx.get('song-a'), null);
    ctx.set('song-a', 'Main Lead');
    assert.equal(ctx.get('song-a'), 'Main Lead');
});

test('applying a lock loads the preset and ignores later tone changes', async () => {
    const { ctx, loads } = harness(PRESETS);
    await ctx.apply('Main Lead');
    assert.deepEqual(loads, ['Main Lead']);
    const sw = ctx.window._toneSwitcher;
    assert.equal(sw.songLock, 'Main Lead');
    sw.switchToTone('mychdead_solo');
    assert.deepEqual(loads, ['Main Lead'], 'a solo tone change does not switch presets');
});

test('song start checks the lock before any switching mode', () => {
    const lockAt = SCREEN_JS.indexOf('const lockedPreset = getSongToneLock(songKey);');
    const midiAt = SCREEN_JS.indexOf('// Check for MIDI PC mode', lockAt);
    const taAt = SCREEN_JS.indexOf('window._aeToneAutomation.installSwitcherForSong(', lockAt);
    assert.ok(lockAt > 0 && midiAt > lockAt && taAt > lockAt);
    assert.match(SCREEN_JS, /if \(!window\._toneSwitcher\.songLock\) showToneToast\(activeTone\);/);
});

test('the picker lives in the player menu, in the Tone & tuning group', () => {
    const inject = extractFunction(SCREEN_JS, 'injectSongTonePicker');
    assert.match(inject, /sel\.id = 'ae-song-tone-pick'/);
    assert.match(inject, /setAttribute\('data-ae-chain'/, 'data-ae-chain puts it in the "Tone & tuning" group');
    assert.match(extractFunction(SCREEN_JS, 'fillSongTonePicker'), /Tone: follow song/);
    // Injected with the chain button on every song, regardless of provider.
    const btn = extractFunction(SCREEN_JS, 'injectPlayerToneButton');
    assert.ok(btn.indexOf('injectSongTonePicker();') < btn.indexOf('shouldShowPlayerChainButton()'));
});

test('every switching path honours the lock', () => {
    const ta = extractFunction(SCREEN_JS, 'installTaSwitcherForSong');
    assert.match(ta, /const locked = getSongToneLock\(songKey\);/);
    const maps = extractFunction(SCREEN_JS, '_applyToneMappingsImpl');
    assert.match(maps, /const lockedForSong = getSongToneLock\(songKey\);/);
    // onSongTonePick sits outside the preload closure: it must not touch
    // _preloadedToneCacheKey (a ReferenceError there broke "follow song").
    const pick = extractFunction(SCREEN_JS, 'onSongTonePick');
    assert.doesNotMatch(pick, /_preloadedToneCacheKey|[^.]startToneAutoSwitch\(/);
});

test('a pick during a queue / album playthrough holds for the next songs', () => {
    const { ctx, q } = harness(PRESETS, { queue: true });
    ctx.setQueueLock('Main Lead');            // what onSongTonePick does mid-queue
    assert.equal(ctx.get('next-song'), 'Main Lead', 'the next song in the run keeps the pick');
    q.on = false;                              // the queue ended
    assert.equal(ctx.get('later-song'), null, 'songs after the run follow their tones again');
    assert.equal(ctx.queueLock(), null, 'and the run lock is cleared');
});

test('a song lock wins over the run lock; picking during a run sets both', () => {
    const { ctx } = harness(PRESETS, { queue: true });
    ctx.set('song-a', 'Auto · Lead (Mesa Mark V)');
    ctx.setQueueLock('Main Lead');
    assert.equal(ctx.get('song-a'), 'Auto · Lead (Mesa Mark V)');
    assert.equal(ctx.get('song-b'), 'Main Lead');
    const pick = extractFunction(SCREEN_JS, 'onSongTonePick');
    assert.match(pick, /if \(playQueueActive\(\)\) _queueToneLock = pick \|\| null;/);
    // The run lock clears when the queue reports inactive.
    assert.match(SCREEN_JS, /'queue:changed'[\s\S]{0,160}if \(d\.active === false\) _queueToneLock = null;/);
});

test('the picker reloads its list on open, so a tone saved mid-song shows up', () => {
    const inject = extractFunction(SCREEN_JS, 'injectSongTonePicker');
    assert.match(inject, /addEventListener\('pointerdown', \(\) => fillSongTonePicker\(sel, false\)\)/);
    assert.match(inject, /addEventListener\('focus', \(\) => fillSongTonePicker\(sel, false\)\)/);
    const fill = extractFunction(SCREEN_JS, 'fillSongTonePicker');
    // An unchanged list never touches the DOM (no flicker / no popup churn).
    assert.match(fill, /if \(!force && sel\._aeSig === sig\) return;/);
});
