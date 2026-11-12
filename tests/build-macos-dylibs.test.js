// The Mac build's dylibbundler step (bundle_brew_dylibs in scripts/build-macos.sh).
//
// v0.4.17 and v0.4.18 Mac builds hung for hours: Homebrew's fluidsynth links
// @rpath/libfluidsynth.3.dylib, dylibbundler had no search path for it and
// prompted for a directory on stdin, which in CI is EOF forever.
//
// Runs the real function in bash with `dylibbundler` and `brew` replaced by
// shell functions. Pins that every call gets Homebrew's lib dirs as search
// paths, that a prompt is answered with "quit" rather than EOF, and that an
// unresolvable library fails the build instead of hanging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-macos.sh'), 'utf8').replace(/\r\n/g, '\n');
const FN = SRC.match(/^bundle_brew_dylibs\(\) \{[\s\S]*?^\}$/m)[0];

function run({ failFor = '' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dylibs-'));
    const bin = path.join(dir, 'bin').replace(/\\/g, '/');
    fs.mkdirSync(bin);
    for (const b of ['fluidsynth', 'ffmpeg', 'vgmstream-cli']) fs.writeFileSync(path.join(bin, b), '');
    const log = path.join(dir, 'calls.log').replace(/\\/g, '/');
    const script = `
set -euo pipefail
BLUE=''; NC=''
brew() { if [[ $# -eq 1 ]]; then echo /opt/homebrew; else echo "/opt/homebrew/opt/$2"; fi; }
dylibbundler() {
    local target="" ; local args="$*"
    while [[ $# -gt 0 ]]; do [[ "$1" == "-x" ]] && target="$2"; shift; done
    local answer=""; read -r answer || answer="<EOF>"
    echo "$(basename "$target")|$args|stdin=$answer" >> "${log}"
    [[ -n "${failFor}" && "$(basename "$target")" == "${failFor}" ]] && return 1
    return 0
}
${FN}
bundle_brew_dylibs "${bin}"
echo DONE
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    fs.rmSync(dir, { recursive: true, force: true });
    return { r, calls };
}

test('every bundled binary gets Homebrew lib search paths and a "quit" answer, not EOF', () => {
    const { r, calls } = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DONE/);
    assert.deepEqual(calls.map((c) => c.split('|')[0]), ['fluidsynth', 'ffmpeg', 'vgmstream-cli'], 'missing binaries (ffprobe) are skipped');
    for (const c of calls) {
        assert.match(c, /-s \/opt\/homebrew\/lib/, `brew lib dir searched: ${c}`);
        assert.match(c, /-p @executable_path\//);
        assert.match(c, /stdin=quit$/, `a prompt is answered with quit: ${c}`);
    }
});

test('a library dylibbundler cannot find fails the build instead of hanging', () => {
    const { r, calls } = run({ failFor: 'fluidsynth' });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /DONE/);
    assert.match(r.stderr, /dylibbundler couldn't find every library fluidsynth needs/);
    assert.equal(calls.length, 1, 'stops at the first failure');
});

test('the build calls the shared function, with no other dylibbundler call site', () => {
    assert.match(SRC, /^\s+bundle_brew_dylibs "\$PROJECT_DIR\/resources\/bin"$/m);
    assert.equal((SRC.match(/^\s*(if ! )?dylibbundler /gm) || []).length, 1);
});
