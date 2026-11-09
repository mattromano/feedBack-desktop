// Untangler safety net for I-002 (desktop-config.ts, extracted from
// soundfont-manager.ts). Pins how <userData>/slopsmith-desktop.json is read and
// written. Electron is stubbed; nothing is spawned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTsStubbed } = require('./_load-ts-stubbed');

function load() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangler-i002-'));
    const stubs = {
        electron: {
            app: { getPath: () => dir, isPackaged: false },
            ipcMain: { handle() {}, on() {} },
            BrowserWindow: { getAllWindows: () => [] },
        },
        './python': { restartPython: async () => {} },
    };
    const mod = loadTsStubbed('src/main/desktop-config.ts', stubs);
    const file = path.join(dir, 'slopsmith-desktop.json');
    return { mod, dir, file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('missing config file reads as {}', () => {
    const t = load();
    try {
        assert.deepEqual(t.mod.getDesktopConfig(), {});
    } finally { t.done(); }
});

test('set writes pretty JSON atomically and get reads it back', () => {
    const t = load();
    try {
        t.mod.setDesktopConfig({ lanAccess: true });
        assert.equal(fs.readFileSync(t.file, 'utf8'), JSON.stringify({ lanAccess: true }, null, 2));
        assert.equal(fs.existsSync(t.file + '.tmp'), false, 'tmp file left behind');
        assert.deepEqual(t.mod.getDesktopConfig(), { lanAccess: true });
    } finally { t.done(); }
});

test('set merges shallowly and keeps keys it does not know about', () => {
    const t = load();
    try {
        fs.writeFileSync(t.file, JSON.stringify({ futureKey: 1, paneWindows: { a: { alwaysOnTop: true } } }));
        t.mod.setDesktopConfig({ startFullscreen: true });
        t.mod.setDesktopConfig({ paneWindows: { b: { alwaysOnTop: false } } });
        assert.deepEqual(t.mod.getDesktopConfig(), {
            futureKey: 1,
            startFullscreen: true,
            paneWindows: { b: { alwaysOnTop: false } }, // shallow: replaces, not deep-merged
        });
    } finally { t.done(); }
});

test('corrupt config reads as {} and the next set still writes the patch', () => {
    const t = load();
    try {
        fs.writeFileSync(t.file, '{ not json');
        assert.deepEqual(t.mod.getDesktopConfig(), {});
        t.mod.setDesktopConfig({ lanAccess: false });
        assert.deepEqual(t.mod.getDesktopConfig(), { lanAccess: false });
        // I-002 will additionally keep the corrupt bytes as a .corrupt backup;
        // that assertion is added with the change itself.
    } finally { t.done(); }
});

test('callers keep importing the config API from one place', () => {
    // Pins the import sites the extraction must move together.
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
    for (const f of ['main.ts', 'pane-hosts.ts', 'python.ts']) {
        assert.match(src(f), /import \{[^}]*getDesktopConfig[^}]*\} from '\.\/(soundfont-manager|desktop-config)'/, f);
    }
});
