// Issue #16: while a preset loads, the engine builds the chain stage by stage with audio
// running, so a high-gain amp played for ~1 s without its cabinet IR (harsh fizz). The swap
// now mutes the guitar chain first; success restores the preset level, failure the slider's.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8').replace(/\r\n/g, '\n');

function fnBody(name) {
    const start = SRC.indexOf(`async function ${name}(`);
    assert.ok(start !== -1, `${name} not found`);
    let i = SRC.indexOf('{', SRC.indexOf(')', start)) + 1, depth = 1;
    while (i < SRC.length && depth > 0) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') depth--; i++; }
    return SRC.slice(start, i);
}

test('the guitar chain is muted before the old chain is cleared', () => {
    const body = fnBody('replaceChainWithPresetBlob');
    const mute = body.indexOf("api.setGain('chain', 0)");
    const clear = body.indexOf('api.clearChain()');
    assert.ok(mute > 0 && clear > mute, 'mute happens before clearChain');
});

test('success restores the preset level after the whole chain is loaded', () => {
    const body = fnBody('replaceChainWithPresetBlob');
    assert.ok(body.indexOf('applyPresetGainLevels(preset)') > body.indexOf('api.loadPreset('));
});

test('both failure paths restore the current level (never left silent)', () => {
    const body = fnBody('replaceChainWithPresetBlob');
    const restores = body.match(/_restorePresetBlob\(snapshotBlob, tag\);\s*restoreChainGain\(\);/g) || [];
    assert.equal(restores.length, 2);
    assert.match(body, /const restoreChainGain = \(\) => \{[\s\S]*?outputGainSlider[\s\S]*?api\.setGain\('chain'/);
});
