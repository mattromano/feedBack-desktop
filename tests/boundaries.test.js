// Architecture boundary rules from ARCHITECTURE.md. Source-reading only, so it
// runs in the fast lane, in CI and in the pre-commit hook. A failure here means
// a change crossed a boundary the untangler refactor set up; fix the change
// (or update ARCHITECTURE.md and this test together, deliberately).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const filesIn = (dir, ext) => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .map(String).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f).replace(/\\/g, '/'));
// Code without // line comments and /* */ blocks (good enough for these checks).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const MAIN = filesIn('src/main', '.ts');
const RENDERER = filesIn('src/renderer', '.js');

function braceBlock(src, openIdx) {
    let i = openIdx + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    return src.slice(openIdx, i);
}

test('rule 1: only audio-bridge.ts loads the native addon', () => {
    const offenders = MAIN.filter((f) => /slopsmith_audio\.node/.test(code(read(f))) && f !== 'src/main/audio-bridge.ts');
    assert.deepEqual(offenders, []);
});

test('rule 2: only desktop-config.ts owns slopsmith-desktop.json', () => {
    const allowed = new Set(['src/main/desktop-config.ts', 'src/main/config-paths.ts']);
    const offenders = MAIN.filter((f) => /slopsmith-desktop\.json/.test(code(read(f))) && !allowed.has(f));
    assert.deepEqual(offenders, []);
    for (const f of MAIN) {
        const m = code(read(f)).match(/import\s*\{[^}]*\b(get|set)DesktopConfig\b[^}]*\}\s*from\s*'([^']+)'/g) || [];
        for (const imp of m) assert.match(imp, /from '\.\/desktop-config'$/, `${f}: ${imp}`);
    }
});

test('rule 3: no Node/electron in the renderer, no renderer code in main', () => {
    for (const f of RENDERER) {
        const c = code(read(f));
        assert.doesNotMatch(c, /\brequire\s*\(/, `${f} uses require()`);
        assert.doesNotMatch(c, /from\s+['"]electron['"]/, `${f} imports electron`);
    }
    for (const f of MAIN) {
        assert.doesNotMatch(code(read(f)), /from\s+['"][^'"]*renderer\//, `${f} imports renderer code`);
    }
});

test('rule 5: tone switchers use the shared switch helpers', () => {
    const src = code(read('src/renderer/screen.js'));
    const marker = 'window._toneSwitcher = {';
    let at = src.indexOf(marker), checked = 0;
    while (at !== -1) {
        const block = braceBlock(src, at + marker.length - 1);
        const line = src.slice(0, at).split('\n').length;
        // Passing api.setMultiBypass to the shared helper is fine; calling the
        // engine directly from a switcher is the copy this rule forbids.
        const ownBypass = /setMultiBypass\(/.test(block) && !/_aeBypassSwitchToTone\(this,/.test(block);
        assert.ok(!ownBypass && !/sendMidiToSlot\(/.test(block),
            `screen.js:~${line} installs a switcher with its own bypass/MIDI logic; use window._aeBypassSwitchToTone / window._aeMakeMidiToneSwitcher`);
        checked++;
        at = src.indexOf(marker, at + 1);
    }
    assert.ok(checked > 0);
    const cls = src.slice(src.indexOf('class ToneSwitcher'));
    const sw = cls.slice(cls.indexOf('switchToTone(toneName) {'));
    assert.match(sw.slice(0, 200), /bypassSwitchToTone\(this,/, 'ToneSwitcher.switchToTone must delegate to bypassSwitchToTone');
});

test('rule 6: song chain rebuilds share one lock', () => {
    const src = read('src/renderer/screen.js');
    assert.match(src, /function applyToneMappingsNow\(songKey, options = \{\}\) \{\n\s*return withToneChainLock\(/);
    assert.equal((src.match(/_applyToneMappingsLock = /g) || []).length, 2, 'the lock is declared once and only advanced inside withToneChainLock');
});

test('rule 7: no new hand-written copies of the callAddon pattern', () => {
    const src = read('src/main/audio-bridge.ts');
    const WARN = "console\\.warn\\(`\\[audio\\] (?<n2>\\w+) failed: \\$\\{(?:e\\?\\.message \\?\\? e|e instanceof Error \\? e\\.message : String\\(e\\))\\}`\\);";
    const one = new RegExp("if \\(!audio \\|\\| typeof audio\\.(?<n>\\w+) !== 'function'\\) return (?<fb>[^;\\n]+);\\n\\s*try \\{ return audio\\.\\k<n>\\([^()\\n]*\\); \\}\\n\\s*catch \\(e(?:: any|: unknown)?\\) \\{\\n\\s*" + WARN + "\\n\\s*return \\k<fb>;", 'g');
    const multi = new RegExp("if \\(!audio \\|\\| typeof audio\\.(?<n>\\w+) !== 'function'\\) return (?<fb>[^;\\n]+);\\n\\s*try \\{\\n\\s*return audio\\.\\k<n>\\([^()\\n]*\\);\\n\\s*\\} catch \\(e(?:: any|: unknown)?\\) \\{\\n\\s*" + WARN + "\\n\\s*return \\k<fb>;", 'g');
    const hits = [...src.matchAll(one), ...src.matchAll(multi)].map((m) => m.groups.n)
        .filter((n) => n !== 'setLivePitch' && n !== 'getLivePitch');
    assert.deepEqual(hits, [], 'use callAddon(name, fallback, ...args) for these');
});
