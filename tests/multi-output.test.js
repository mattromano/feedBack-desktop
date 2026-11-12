// "Play on multiple outputs" wiring.
//
// The setting lives in desktop-config (main-owned). With it on, every
// setDevice call carries multiOutput:true to the addon, which opens every
// advertised output channel; the engine copies the post-gain stereo mix to
// each further pair and silences the output channels the user muted (live,
// by channel name).
//
// Behaviour is checked against audio-bridge.ts with a fake addon and a temp
// userData dir (nothing loads the native engine). The C++ and renderer halves
// are checked by reading source, like the other safety nets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTsStubbed, ROOT } = require('./_load-ts-stubbed');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function loadBridge(existingDir) {
    const tmp = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), 'multi-output-'));
    const handlers = new Map();
    const calls = [];
    const electron = {
        ipcMain: {
            handle: (ch, fn) => handlers.set(ch, fn),
            on: (ch, fn) => handlers.set(ch, fn),
        },
        app: { getPath: () => tmp, isPackaged: false },
    };
    const stubs = {
        electron,
        './debug-log': { isDebugEnabled: () => false, getDebugLogPath: () => path.join(tmp, 'debug.log') },
        './vst-crash-guard': {
            initVstCrashGuard: () => [],
            armSentinel() {}, disarmSentinel() {}, armEditorSentinel() {},
            getSentinelPath: () => path.join(tmp, 'sentinel'),
        },
    };
    const addon = new Proxy({}, {
        get(_t, name) {
            if (typeof name !== 'string' || name === 'then') return undefined;
            if (name === 'init') return () => undefined;
            if (name === 'setDevice') return (...a) => { calls.push(['setDevice', ...a]); return { ok: true, duplex: true }; };
            return (...a) => { calls.push([name, ...a]); return 0; };
        },
        has() { return true; },
    });
    const resolveExtra = (id) => (id.endsWith('slopsmith_audio.node') ? addon : undefined);
    const orig = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    try {
        const bridge = loadTsStubbed('src/main/audio-bridge.ts', stubs, resolveExtra);
        bridge.initAudioBridge();
    } finally {
        Object.assign(console, orig);
    }
    const configFile = path.join(tmp, 'slopsmith-desktop.json');
    const config = () => (fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {});
    const invoke = (ch, ...args) => handlers.get(ch)({ sender: { send() {} } }, ...args);
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    return { handlers, calls, invoke, config, configFile, cleanup, dir: tmp };
}

const DEVICE = {
    inputType: 'ASIO', inputDevice: 'ASIO4ALL v2', outputType: 'ASIO', outputDevice: 'ASIO4ALL v2',
    sampleRate: 48000, bufferSize: 256,
};

test('multi-output: off by default; setDevice carries multiOutput:false', () => {
    const b = loadBridge();
    try {
        assert.deepEqual(b.invoke('audio:getMultiOutput'), { enabled: false, mutedOutputChannels: [] });
        b.invoke('audio:setDevice', { ...DEVICE });
        const sent = b.calls.filter((c) => c[0] === 'setDevice').pop();
        assert.equal(sent[1].multiOutput, false);
    } finally { b.cleanup(); }
});

test('multi-output: the switch persists to desktop-config and reaches every setDevice', () => {
    const b = loadBridge();
    try {
        assert.equal(b.invoke('audio:setMultiOutput', true), true);
        assert.equal(b.config().multiOutput, true);
        // The renderer never sends the flag; main injects it, and ignores a
        // renderer-supplied value in favour of the saved setting.
        b.invoke('audio:setDevice', { ...DEVICE, multiOutput: false });
        assert.equal(b.calls.filter((c) => c[0] === 'setDevice').pop()[1].multiOutput, true);

        assert.equal(b.invoke('audio:setMultiOutput', false), false);
        assert.equal(b.config().multiOutput, false);
        b.invoke('audio:setDevice', { ...DEVICE });
        assert.equal(b.calls.filter((c) => c[0] === 'setDevice').pop()[1].multiOutput, false);
    } finally { b.cleanup(); }
});

test('multi-output: a non-boolean switch value changes nothing', () => {
    const b = loadBridge();
    try {
        assert.equal(b.invoke('audio:setMultiOutput', 'yes'), false);
        assert.equal(fs.existsSync(b.configFile), false);
    } finally { b.cleanup(); }
});

test('multi-output: mutes persist by name, are sanitised, and apply only while the switch is on', () => {
    const b = loadBridge();
    try {
        const pushed = () => b.calls.filter((c) => c[0] === 'setMutedOutputChannels').pop()[1];
        // Startup push: nothing muted.
        assert.deepEqual(pushed(), []);

        const saved = b.invoke('audio:setMutedOutputChannels',
            ['Speakers (Realtek(R) Audio) 1', 'Speakers (Realtek(R) Audio) 2', ' ', 7, 'Speakers (Realtek(R) Audio) 1']);
        assert.deepEqual(saved, ['Speakers (Realtek(R) Audio) 1', 'Speakers (Realtek(R) Audio) 2']);
        assert.deepEqual(b.config().mutedOutputChannels, saved);
        // Switch is off: the first pair is the only output, so no mute reaches the engine.
        assert.deepEqual(pushed(), []);

        b.invoke('audio:setMultiOutput', true);
        assert.deepEqual(pushed(), saved);

        b.invoke('audio:setMultiOutput', false);
        assert.deepEqual(pushed(), []);
        // Turning it off keeps the saved mutes for next time.
        assert.deepEqual(b.config().mutedOutputChannels, saved);

        // Malformed payload: no change.
        assert.deepEqual(b.invoke('audio:setMutedOutputChannels', 'nope'), saved);
    } finally { b.cleanup(); }
});

test('multi-output: saved setting + mutes are pushed to the engine at startup', () => {
    const first = loadBridge();
    try {
        first.invoke('audio:setMultiOutput', true);
        first.invoke('audio:setMutedOutputChannels', ['Speakers (PRO) 1', 'Speakers (PRO) 2']);
        // A fresh launch against the same userData: initAudioBridge alone must
        // hand the saved mutes to the engine, before any IPC call.
        const next = loadBridge(first.dir);
        const startup = next.calls.filter((c) => c[0] === 'setMutedOutputChannels');
        assert.deepEqual(startup, [['setMutedOutputChannels', ['Speakers (PRO) 1', 'Speakers (PRO) 2']]]);
    } finally { first.cleanup(); }
});

test('multi-output: desktop-config owns both keys', () => {
    const src = read('src/main/desktop-config.ts');
    assert.match(src, /\n\s+multiOutput\?: boolean;/);
    assert.match(src, /\n\s+mutedOutputChannels\?: string\[\];/);
});

test('multi-output: addon reads multiOutput from the setDevice payload and exports the mute calls', () => {
    const bind = read('src/audio/addon/DeviceBindings.cpp');
    assert.match(bind, /cfg\.multiOutput = obj\.Has\("multiOutput"\)/);
    const addon = read('src/audio/NodeAddon.cpp');
    assert.match(addon, /exports\.Set\("setMutedOutputChannels"/);
    // Main is the source of truth for the mutes: no getter on the addon.
    assert.doesNotMatch(addon, /getMutedOutputChannels/);
    const engine = read('src/audio/AudioEngine.cpp');
    assert.match(engine, /deviceSetup\.applyDuplex\([^;]*config\.multiOutput\);/);
});

test('multi-output: every output-mask site in DeviceSetup goes through outputChannelsToOpen', () => {
    const src = read('src/audio/engine/DeviceSetup.cpp');
    // The skip check, the duplex open, the duplex verify and the split open
    // must agree, or toggling either never reopens or fails the verify closed.
    assert.doesNotMatch(src, /outputChannels\.setRange\(0, juce::jmin\(/);
    assert.doesNotMatch(src, /expectedOutputs\.setRange\([^;]*juce::jmin\(/);
    assert.equal((src.match(/outputChannelsToOpen\(/g) || []).length, 4);
    assert.match(src, /outSetup\.outputChannels\.setRange\(0, outputChannelsToOpen\(outputChannelCount, config\.multiOutput\), true\);/);
    const hdr = read('src/audio/engine/DeviceSetup.h');
    assert.match(hdr, /return multiOutput \? n : juce::jmin\(n, 2\);/);
});

test('multi-output: both callbacks fan out after master gain, metering the first pair', () => {
    const src = read('src/audio/AudioEngine.cpp');
    // Duplex: mixes into the first pair only.
    assert.match(src, /buffer\.setDataToReferTo\(outputData, mixOutputChannels, numSamples\);/);
    const duplex = src.slice(src.indexOf('// Apply output gain'), src.indexOf('int AudioEngine::activeExtraInputCount'));
    assert.ok(duplex.indexOf('buffer.applyGain(outputGain.load());') < duplex.indexOf('fanOutStereoMix('));
    assert.ok(duplex.indexOf('loopRing[') < duplex.indexOf('fanOutStereoMix('), 'loop ring reads the pre-fan-out mix');
    assert.match(duplex, /for \(int ch = 0; ch < mixOutputChannels; \+\+ch\)\n\s+peak = /);
    // Split output callback.
    const split = src.slice(src.indexOf('void AudioEngine::audioOutputCallback('), src.indexOf('int AudioEngine::recomputeMutedOutputMaskLocked'));
    assert.ok(split.lastIndexOf('buffer.applyGain(outputGain.load());') < split.indexOf('fanOutStereoMix('));
    assert.match(split, /for \(int ch = 0; ch < copyChannels; \+\+ch\)\n\s+peak = /);
    // Mutes are re-resolved against the channel list whenever a device starts.
    assert.equal((src.match(/captureActiveOutputChannels\(device\);/g) || []).length, 2);
    // Each callback keeps its own previous mask (for the mute fade), reset to
    // the current mask before its device starts.
    assert.match(duplex, /fanOutStereoMix\([^;]*duplexFanoutPrevMask\);/);
    assert.match(split, /fanOutStereoMix\([^;]*splitFanoutPrevMask\);/);
    assert.match(src, /duplexFanoutPrevMask = mutedOutputMask\.load/);
    assert.match(src, /splitFanoutPrevMask = mutedOutputMask\.load/);
});

test('multi-output: the fan-out has a real buffer test in engine_units', () => {
    const cmake = read('tests/engine_units/CMakeLists.txt');
    assert.match(cmake, /add_executable\(output_fanout_test output_fanout_test\.cpp\)/);
    assert.match(cmake, /add_test\(NAME output_fanout COMMAND output_fanout_test\)/);
    // JUCE-free, so the unit test builds without the engine.
    assert.doesNotMatch(read('src/audio/engine/OutputFanout.h'), /#include <juce/);
});

test('multi-output: renderer toggle re-runs Apply and lists output pairs from the probe', () => {
    const src = read('src/renderer/screen.js');
    assert.match(src, /applyDeviceBtn\.addEventListener\('click', \(\) => applyDeviceForm\(\)\);/);
    assert.match(src, /multiOutputCheckbox\?\.addEventListener\('change', async \(\) => \{[\s\S]*?await api\.setMultiOutput\(enabled\)[\s\S]*?await applyDeviceForm\(\);/);
    assert.match(src, /renderOutputPairs\(options\?\.outputChannels\);/);
    assert.match(src, /await api\.setMutedOutputChannels\(\[\.\.\.muted\]\)/);
    const html = read('src/renderer/screen.html');
    assert.match(html, /id="ae-multi-output"/);
    assert.match(html, /id="ae-output-pairs"/);
});
