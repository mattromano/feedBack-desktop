// Multi-device ASIO drivers (ASIO4ALL) list every enabled device's inputs in
// one flat list. With the PC's onboard audio enabled (for its speaker out),
// its mic pair comes first, so the old "Default pair" read a dead mic and the
// guitar cable was never heard. pickGuitarInputChannel() moves the default to
// the guitar/USB channel only when that's clear-cut.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const SCREEN_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
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

const ctx = {};
vm.runInNewContext(`${extractFunction(SCREEN_JS, 'pickGuitarInputChannel')}; this.pick = pickGuitarInputChannel;`, ctx);
const pick = ctx.pick;

test('ASIO4ALL with onboard mic first picks the USB guitar cable', () => {
    // The exact list ASIO4ALL gave with Realtek + a C-Media guitar cable enabled.
    assert.equal(pick(['HD Audio Mic input 1', 'HD Audio Mic input 2', 'USB Audio Device 1', 'USB Audio Device 2']), 2);
});

test('named instrument inputs are picked over a mic pair', () => {
    assert.equal(pick(['Microphone 1', 'Microphone 2', 'Rocksmith Guitar Adapter 1']), 2);
    assert.equal(pick(['Webcam Mic L', 'Webcam Mic R', 'Line 1', 'Inst 1 (Hi-Z)']), 3);
});

test('keeps the default when the first pair is not a mic', () => {
    // A real interface: its own inputs come first and are what the user wants.
    assert.equal(pick(['Focusrite Input 1', 'Focusrite Input 2', 'USB Audio Device 1']), -1);
    assert.equal(pick(['USB Audio Device 1', 'USB Audio Device 2', 'HD Audio Mic input 1']), -1);
});

test('keeps the default when no later channel looks like a guitar', () => {
    assert.equal(pick(['HD Audio Mic input 1', 'HD Audio Mic input 2', 'Stereo Mix 1', 'Stereo Mix 2']), -1);
    assert.equal(pick(['HD Audio Mic input 1', 'HD Audio Mic input 2', 'USB Microphone 1']), -1);
});

test('two or fewer channels never change (plain mono/stereo devices)', () => {
    assert.equal(pick(['Microphone 1', 'Microphone 2']), -1);
    assert.equal(pick(['USB Audio Device 1']), -1);
    assert.equal(pick([]), -1);
    assert.equal(pick(undefined), -1);
});

test('startup restore does not re-set a saved default over the pick', () => {
    // init() used to call setSelectValueIfPresent(inputChannelSelect, saved.inputChannel)
    // unconditionally right after refreshDeviceOptions(), which would put "-1" back.
    assert.match(SCREEN_JS, /if \(String\(saved\.inputChannel\) !== '-1'\) \{\s*setSelectValueIfPresent\(inputChannelSelect, saved\.inputChannel\);/);
    // And the option renderer consults the picker only for the default.
    const render = extractFunction(SCREEN_JS, 'renderInputChannelOptions');
    assert.match(render, /if \(String\(selected\) === '-1'\)/);
    assert.match(render, /pickGuitarInputChannel\(names\)/);
});
