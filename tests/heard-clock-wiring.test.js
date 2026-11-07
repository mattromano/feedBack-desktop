// Wiring for the heard clocks (source-level; the math itself is unit-tested in
// tests/engine_units — renderer_bus_test, playhead_model_test — and the onset
// lag in tests/onset_lag):
//  - guitar: every input block is stamped at callback start, the verifier
//    places each sample from that stamp minus the device's capture latency
//    (reported input latency - one buffer), on a rate-measured playhead;
//  - song (stems): a second, frame-stamped bus mixed into the output and
//    stamped with the output callback's start, so getSongBusClock() names the
//    context frame being heard (output latency included);
//  - song (native backing): getBackingPosition() is the heard position.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'latin1').replace(/\r\n/g, '\n');

test('capture latency = reported input latency minus one buffer, set on every pooled chain', () => {
    const src = read('src/audio/AudioEngine.cpp');
    assert.match(src, /const int inLat = device->getInputLatencyInSamples\(\);\s*const double capSec = \(sr > 0\.0\) \? \(double\) juce::jmax\(0, inLat - bs\) \/ sr : 0\.0;\s*pool\.forEach\(\[&\]\(SourceChain& s\) \{ s\.setCaptureLatencySec\(capSec\); \}\);/);
});

test('each input block is stamped at callback start and published after its samples', () => {
    const src = read('src/audio/SourceChain.cpp');
    const body = src.slice(src.indexOf('void SourceChain::processBlock('));
    const stamp = body.indexOf('const double blockStartMs = juce::Time::getMillisecondCounterHiRes();');
    const firstUse = body.indexOf('inputGain.load()');
    assert.ok(stamp !== -1 && stamp < firstUse, 'wall time taken before any DSP');
    assert.match(body, /inputFrameRingWriteIndex\.store\(w \+ \(uint64_t\) numSamples, std::memory_order_release\);\s*\n\s*\/\/ Publish the capture stamp[\s\S]{0,400}inputStampIndex\.store\(w \+ \(uint64_t\) numSamples/);
});

test('the verifier times onsets from the stamp, the capture latency and the measured rate', () => {
    const src = read('src/audio/NoteVerifier.cpp');
    assert.match(src, /const double playhead = stamped \? stampSong - captureLatency \* rate : currentPlayhead\(\);/);
    assert.match(src, /slopsmith::onsetSongTime\(stampSong, stampIdx, o\.sampleIndex, sr, captureLatency, rate\)/);
    assert.match(src, /playheadModel\.push\(song, playing, now\);/);
});

test('onset backdate is the detector lag in samples, not a tuned time', () => {
    const src = read('src/audio/OnsetDetector.cpp');
    assert.match(src, /constexpr int kGuitarBackdateSamples = 525;/);
    assert.doesNotMatch(src, /BackdateSeconds/);
});

test('song bus: mixed into the same pull, stamped with the output callback start', () => {
    const src = read('src/audio/AudioEngine.cpp');
    assert.match(src, /songBus\.pull\(songBusPullScratch\.getWritePointer\(0\),\s*songBusPullScratch\.getWritePointer\(1\),\s*numSamples, outputCallbackStartMs\.load\(std::memory_order_relaxed\)\);/);
    // Both output callbacks stamp their start first thing.
    assert.equal((src.match(/outputCallbackStartMs\.store\(juce::Time::getMillisecondCounterHiRes\(\)/g) || []).length, 2);
    // The clock adds the device output latency.
    assert.match(src, /c\.heardSourceFrame = h\.sourceFrame \+ \(sinceMs - outLatMs\) \/ 1000\.0 \* c\.sourceFramesPerSecond;/);
    // Output latency is recorded on both start paths (duplex + split).
    assert.equal((src.match(/outputLatencySamples\.store\(device->getOutputLatencyInSamples\(\)/g) || []).length, 2);
});

test('native backing reports the HEARD position', () => {
    const src = read('src/audio/AudioEngine.cpp');
    assert.match(src, /const double heard = \(pos - blockSec \* rate\) \+ \(\(nowMs - ms\) \/ 1000\.0 - outLatSec\) \* rate;/);
    assert.equal((src.match(/publishBackingStamp\((outSamples|backingOut)\);/g) || []).length, 2, 'both output paths stamp it');
});

test('bridge + preload expose the song bus', () => {
    const bridge = read('src/main/audio-bridge.ts');
    for (const ch of ['audio:setSongBus', 'audio:pushSongAudio', 'audio:getSongBusClock', 'audio:getSongBusMetrics'])
        assert.ok(bridge.includes(`'${ch}'`), ch);
    const preload = read('src/main/preload.ts');
    for (const k of ['setSongBus:', 'pushSongAudio:', 'getSongBusClock:', 'getSongBusMetrics:'])
        assert.ok(preload.includes(k), k);
    const addon = read('src/audio/NodeAddon.cpp');
    for (const k of ['setSongBus', 'pushSongAudio', 'getSongBusClock', 'getSongBusMetrics'])
        assert.ok(addon.includes(`exports.Set("${k}"`), k);
});
