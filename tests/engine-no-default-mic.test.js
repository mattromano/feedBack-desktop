'use strict';

// Guitar input must never fall back to a microphone the user didn't configure.
// Before this, the engine opened the OS default duplex device in its
// constructor and never closed the input side, so any startAudio() without a
// successful setDevice (note detection, tuner, Rig Builder, NAM keep-alive…)
// captured the default mic — the highway reacted to the singer's voice and an
// amp chain played it back into the headset. An empty input name likewise
// resolved to the first enumerated input.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const engine = read('src/audio/AudioEngine.cpp');
const header = read('src/audio/AudioEngine.h');

function body(src, signature, nextSignature) {
    const start = src.indexOf(signature);
    const end = src.indexOf(nextSignature, start + signature.length);
    assert.ok(start >= 0 && end > start, `could not locate ${signature}`);
    return src.slice(start, end);
}

const ctor = body(engine, 'AudioEngine::AudioEngine()', 'auto& availableTypes = inputDeviceManager.getAvailableDeviceTypes();');
const setDevices = body(engine, 'AudioEngine::DeviceConfigResult AudioEngine::setAudioDevices(', 'void AudioEngine::teardownSplitMode()');
const start = body(engine, 'void AudioEngine::startAudio()', 'void AudioEngine::stopAudio()');

test('engine tracks whether a guitar input was actually configured', () => {
    assert.match(header, /std::atomic<bool> deviceConfigured\s*\{\s*false\s*\};/);
});

test('constructor closes the default input device it opened', () => {
    const init = ctor.indexOf('inputDeviceManager.initialiseWithDefaultDevices(2, 2)');
    const close = ctor.indexOf('inputDeviceManager.closeAudioDevice();', init);
    assert.ok(init >= 0 && close > init, 'the constructor must close the default input after initialising');
});

test('setAudioDevices rejects an empty input instead of picking some mic', () => {
    const guard = setDevices.indexOf('if (config.inputDevice.isEmpty())');
    const stop = setDevices.indexOf('stopAudio();');
    assert.ok(guard >= 0 && guard < stop, 'empty input must be rejected before touching the running setup');
    assert.match(setDevices.slice(guard, stop), /res\.error = "No guitar input selected";\s*return res;/);
});

test('configured flag is cleared before reconfiguring and set only on success', () => {
    const clear = setDevices.indexOf('deviceConfigured.store(false');
    const stop = setDevices.indexOf('stopAudio();');
    assert.ok(clear > stop, 'flag must be cleared once the old setup is torn down');
    const sets = setDevices.match(/deviceConfigured\.store\(true/g) || [];
    assert.equal(sets.length, 1, 'exactly one success point sets the flag');
    const set = setDevices.indexOf('deviceConfigured.store(true');
    const restart = setDevices.indexOf('if (wasRunning) startAudio();');
    assert.ok(set > clear && set < restart, 'flag is set after both duplex/split succeed, before the restart');
});

test('startAudio refuses to capture until a guitar input is configured', () => {
    const intent = start.indexOf('state.userWantsAudio.store(true');
    const guard = start.indexOf('if (!deviceConfigured.load(');
    const addCb = start.indexOf('inputDeviceManager.addAudioCallback(this)');
    assert.ok(intent >= 0 && guard > intent, 'keep the intent so a later successful setDevice starts audio');
    assert.ok(addCb > guard, 'the guard must come before any audio callback is attached');
    assert.match(start.slice(guard, addCb), /return;/);
});
