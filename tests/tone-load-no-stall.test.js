// A tone switch froze the whole audio callback for ~0.75 s (measured on ASIO: the
// renderer bus backed up to ~37k frames, then dropped — heard as a hard glitch and a
// sync jump). LoadPreset loads each NAM/IR slot by path, then applies the slot's saved
// state, which re-loaded the SAME model a second time while the slot was live. These
// pin the fix (skip a same-file reload) and the audio-thread hardening (never block on
// the NAM model lock), plus the verdict `timed` flag timing consumers rely on.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

function fnBody(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `${signature} not found`);
    let i = src.indexOf('{', start + signature.length) + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    return src.slice(start, i);
}

test('NAM state restore skips reloading the model that is already loaded', () => {
    const body = fnBody(read('src/audio/NAMProcessor.cpp'), 'void NAMProcessor::setStateInformation(');
    assert.match(body, /modelLoaded\.load\(\) && juce::File\(path\) == juce::File\(currentModelPath\)/);
    assert.match(body, /!\s*\(modelLoaded[\s\S]*?\)\)\s*loadModel\(/);
});

test('IR state restore skips reloading the IR that is already loaded', () => {
    const body = fnBody(read('src/audio/IRLoader.cpp'), 'void IRLoader::setStateInformation(');
    assert.match(body, /irLoaded\.load\(\) && juce::File\(path\) == juce::File\(currentIRPath\)/);
});

test('the NAM audio path never blocks on the model lock', () => {
    const body = fnBody(read('src/audio/NAMProcessor.cpp'), 'void NAMProcessor::processBlock(');
    assert.match(body, /ScopedTryLock sl\(modelLock\)/);
    assert.doesNotMatch(body, /const juce::ScopedLock sl\(modelLock\)/);
    assert.match(body, /if \(!sl\.isLocked\(\)\)\s*\{\s*buffer\.clear\(\);\s*return;/);
});

test('verdicts carry `timed`, true only when a pick attack was claimed', () => {
    assert.match(read('src/audio/NoteVerifier.h'), /bool timed = false;/);
    const cpp = read('src/audio/NoteVerifier.cpp');
    assert.match(cpp, /when = onsetLog\[\(size_t\) attack\]\.songTime;\s*timed = true;/);
    assert.match(cpp, /v\.timed = timed;/);
    const bindings = read('src/audio/addon/DeviceBindings.cpp');
    assert.equal((bindings.match(/entry\.Set\("timed", v\.timed\);/g) || []).length, 2,
        'both getNoteVerdicts and getSourceNoteVerdicts expose it');
});

test('a palm-muted note the comb missed counts on its pick attack', () => {
    const cpp = read('src/audio/NoteVerifier.cpp');
    assert.match(cpp, /const int attack = legato \? -1 : slopsmith::nearestUnclaimedOnset\(onsetLog, cn\.t, tol\);/);
    assert.match(cpp, /const bool onAttack = slopsmith::palmMuteHitOnAttack\(hit, cn\.pm, legato, attack >= 0\);\s*\n\s*if \(hit \|\| onAttack\)/);
    assert.match(read('src/audio/addon/DeviceBindings.cpp'), /n\.pm = truthy\("pm"\);/);
});
