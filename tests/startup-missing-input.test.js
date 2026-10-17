'use strict';

// Startup must fail closed when the saved input device is not connected.
// Before this, a missing saved input (e.g. an unplugged guitar interface)
// left the input <select> on "Default"; the probe then passed and setDevice
// opened the FIRST enumerated input — on a Mac with a USB headset, the
// headset mic — and played it live through the loaded amp chain.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8').replace(/\r\n/g, '\n');

const start = source.indexOf('const saved = await loadDeviceSettings();');
const end = source.indexOf('await api.startAudio();', start);
assert.ok(start >= 0 && end > start, 'could not locate the startup auto-apply block in screen.js');
const startup = source.slice(start, end);

test('startup detects a saved input device that is not connected', () => {
    assert.match(startup,
        /const savedInputMissing = !!saved\.input && !selectHasValue\(inputDeviceSelect, saved\.input\);/);
});

test('a missing saved input skips auto-apply instead of falling back to another mic', () => {
    const guard = startup.indexOf('if (savedInputMissing)');
    const notConnected = startup.indexOf('Saved input device not connected', guard);
    const setDevice = startup.indexOf('api.setDevice(');
    assert.ok(guard >= 0, 'startup must branch on savedInputMissing');
    assert.ok(notConnected > guard, 'the user must be told the saved input is not connected');
    assert.ok(setDevice > notConnected, 'setDevice must only be reachable after the missing-input branch');
    // setDevice lives in the else-branch of the guard chain, not after it unconditionally.
    const between = startup.slice(guard, setDevice);
    assert.match(between, /\} else if \(!probedCompatible\) \{[\s\S]*\} else \{/);
});

test('Start button reports a refused start instead of claiming "Audio running"', () => {
    const at = source.indexOf("toggleBtn.addEventListener('click', async () => {");
    assert.ok(at >= 0, 'toggle handler not found');
    const handler = source.slice(at, source.indexOf('deviceTypeSelect.addEventListener', at));
    const start = handler.indexOf('await api.startAudio();');
    const check = handler.indexOf('await api.isAudioRunning', start);
    const refused = handler.indexOf('No guitar input configured', check);
    const running = handler.indexOf("statusText.textContent = 'Audio running';", start);
    assert.ok(check > start, 'must ask the engine whether it actually started');
    assert.ok(refused > check && refused < running, 'refused start must be reported before the running branch');
});
