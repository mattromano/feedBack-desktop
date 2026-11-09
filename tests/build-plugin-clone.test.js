// Untangler safety net for I-006 (a failed plugin clone must fail the build).
//
// Runs the real clone_slopsmith() from scripts/build-common.sh in bash under
// `set -euo pipefail` (as the build does), with `git` replaced by a shell
// function that only creates directories. No network, nothing outside a temp
// dir. Pins the plugin list and the repo -> directory-name mapping, and the
// current (lenient) failure behaviour that I-006 is meant to change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-common.sh'), 'utf8');
const FN = SRC.match(/^clone_slopsmith\(\) \{[\s\S]*?^\}$/m)[0];

const EXPECTED_DIRS = [
    // Snapshot of every bundled plugin directory as of the untangler baseline.
    // Adding/removing a plugin is a deliberate edit to this list.
    'autotune', 'bongocat', 'camera_director', 'drums', 'editor', 'five_fret',
    'flappy_bend', 'fretboard', 'guitar_theory', 'invert_highway', 'jumpingtab', 'loose_folder',
    'lyrics_karaoke', 'metronome', 'midi', 'multiplayer', 'musicxml_import', 'nam_tone',
    'notedetect', 'piano', 'practice', 'rig_builder', 'rockherosmith', 'scorecard',
    'sectionmap', 'song_preview', 'splitscreen', 'staffview', 'stem_splitter', 'stems',
    'stepmode', 'strum_fighter', 'studio', 'tabview', 'themes', 'transpose_chords',
    'tutorials', 'virtuoso',
];

function run(failPattern = '') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'untangler-i006-'));
    const harness = `
set -euo pipefail
git() {
  local dest="\${@: -1}" url="\${@: -2:1}"
  if [[ -n "$FAIL" && "$url" == *"$FAIL"* ]]; then return 128; fi
  mkdir -p "$dest/plugins"
}
${FN}
unset SLOPSMITH_DIR
clone_slopsmith "$TMPC/clone"
echo "DIRS:$(cd "$TMPC/clone/plugins" && ls -1 | tr '\\n' ' ')"
`;
    const r = spawnSync('bash', ['-c', harness], {
        env: { ...process.env, FAIL: failPattern, TMPC: tmp.replace(/\\/g, '/'), GH_CLONE_TOKEN: '' },
        encoding: 'utf8',
        timeout: 30000,
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    const dirs = ((r.stdout.match(/^DIRS:(.*)$/m) || [])[1] || '').trim().split(/\s+/).filter(Boolean).sort();
    return { status: r.status, out: r.stdout, err: r.stderr, dirs };
}

test('all clones succeed: every plugin lands in its expected directory', () => {
    const r = run();
    assert.equal(r.status, 0, r.err);
    const m = r.out.match(/Cloned (\d+) of (\d+) plugins/);
    assert.ok(m, r.out);
    assert.equal(m[1], m[2]);
    assert.equal(r.dirs.length, Number(m[2]));
    assert.deepEqual(r.dirs, EXPECTED_DIRS);
    for (const d of r.dirs) assert.match(d, /^[a-z0-9_]+$/, `plugin dir "${d}" is not a valid module name`);
});

test('a failed plugin clone is reported (current behaviour: build continues)', () => {
    const r = run('feedBack-plugin-scorecard');
    assert.match(r.out, /skipped mattromano\/feedBack-plugin-scorecard/);
    assert.match(r.out, /Cloned (\d+) of (\d+) plugins/);
    const [, got, total] = r.out.match(/Cloned (\d+) of (\d+) plugins/);
    assert.equal(Number(got), Number(total) - 1);
    assert.ok(!r.dirs.includes('scorecard'));
    // I-006 flips this to a non-zero exit unless ALLOW_MISSING_PLUGINS=1.
    assert.equal(r.status, 0);
});

test('a failed core clone stops the build', () => {
    const r = run('mattromano/feedBack.git');
    assert.notEqual(r.status, 0);
});
