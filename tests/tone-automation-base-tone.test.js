// Issue #15: Tone Automation filed a song's BASE tone under "solo" when its name contained
// "lead"/"solo" (CDLC: "Lead", "mychdead_solo"), so the whole song played on the solo preset.
// The base tone now takes the idle (default) target; real solo tone changes keep solo.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8');

function extractClass(src, name) {
    const start = src.indexOf(`class ${name} {`);
    assert.ok(start !== -1, `class ${name} not found`);
    let i = src.indexOf('{', start) + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    return src.slice(start, i);
}

function harness({ overrides = {} } = {}) {
    const loads = [];
    const cfg = { enabled: true, targets: { idle: 'Main Lead', solo: 'Metal Lead', dist: 'Main Lead' } };
    const ctx = {
        window: { _aeTaSessionOverrides: overrides },
        console: { log() {} },
        readTaStore: () => cfg,
        // Stub classifier: "lead"/"solo" in the name -> solo, else idle (mirrors the real keyword split).
        getTaSessionEffectivePreset: (t) => {
            const category = /lead|solo/i.test(t) ? 'solo' : 'idle';
            const autoName = cfg.targets[category];
            const effectiveName = Object.prototype.hasOwnProperty.call(overrides, t) ? overrides[t] : autoName;
            return { autoName, effectiveName, category };
        },
        loadPresetByName: async (n) => { loads.push(n); return true; },
    };
    vm.runInNewContext(`${extractClass(SRC, 'ToneAutomationSwitcher')}; this.S = ToneAutomationSwitcher;`, ctx);
    return { S: ctx.S, loads };
}

test('a base tone named "Lead" plays the default tone, not the solo preset', async () => {
    const { S, loads } = harness();
    const sw = new S();
    sw.baseTone = 'Lead';
    await sw.switchToTone('Lead');
    assert.deepEqual(loads, ['Main Lead']);
});

test('a "<song>_solo" base tone is treated the same way', async () => {
    const { S, loads } = harness();
    const sw = new S();
    sw.baseTone = 'mychdead_solo';
    await sw.switchToTone('mychdead_solo');
    assert.deepEqual(loads, ['Main Lead']);
});

test('a real solo tone change still gets the solo preset, and returning to base goes back', async () => {
    const { S, loads } = harness();
    const sw = new S();
    sw.baseTone = 'Lead';
    await sw.switchToTone('Lead');
    await sw.switchToTone('Guitar Solo');
    await sw.switchToTone('Lead');
    assert.deepEqual(loads, ['Main Lead', 'Metal Lead', 'Main Lead']);
});

test("the user's own per-tone override still wins", async () => {
    const { S, loads } = harness({ overrides: { Lead: 'Metal Lead' } });
    const sw = new S();
    sw.baseTone = 'Lead';
    await sw.switchToTone('Lead');
    assert.deepEqual(loads, ['Metal Lead']);
});

test('the install sets the base tone on the switcher', () => {
    assert.match(SRC, /const switcher = new ToneAutomationSwitcher\(\);\s*switcher\.baseTone = String\(toneBase \|\| ''\)\.trim\(\);/);
});
