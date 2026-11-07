// src/renderer/screen.js is several sibling IIFEs. A function declared inside one is invisible
// to the others, and a bare call across that boundary only fails at runtime (issue #12:
// `getSongToneLock is not defined` on every song). Pin it statically: no IIFE may call a
// top-level function that only exists in a different IIFE — cross-IIFE access goes through
// a `window.*` export.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.js'), 'utf8').replace(/\r\n/g, '\n');

function iifes(src) {
    const lines = src.split('\n');
    const segs = [];
    let cur = null;
    lines.forEach((line) => {
        if (/^\(function\s*\(\)\s*\{/.test(line)) { cur = []; return; }
        if (/^\}\)\(\);/.test(line)) { if (cur) segs.push(cur.join('\n')); cur = null; return; }
        if (cur) cur.push(line);
    });
    return segs;
}

// Function declarations at the IIFE's own top level (4-space indent).
function topLevelFns(seg) {
    const out = new Set();
    for (const m of seg.matchAll(/^ {4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) out.add(m[1]);
    return out;
}
// Names an IIFE defines for itself as variables (e.g. `const getCurrentSongKey = window._ae… || …`).
function topLevelVars(seg) {
    const out = new Set();
    for (const m of seg.matchAll(/^ {4}(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) out.add(m[1]);
    return out;
}

// Code only: drop comments and string/template literals so prose mentions don't count.
function codeOnly(seg) {
    return seg
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
        .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
        .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

test('screen.js is made of several IIFEs', () => {
    assert.ok(iifes(SRC).length >= 2);
});

test('no IIFE calls a top-level function that only another IIFE declares', () => {
    const segs = iifes(SRC);
    const decl = segs.map(topLevelFns);
    const vars = segs.map(topLevelVars);
    const problems = [];
    segs.forEach((seg, i) => {
        const code = codeOnly(seg);
        decl.forEach((names, j) => {
            if (i === j) return;
            for (const name of names) {
                if (decl[i].has(name) || vars[i].has(name)) continue;   // its own copy / alias
                // a bare call: not a property access (x.name) or a declaration
                const re = new RegExp(`(^|[^.\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'm');
                if (re.test(code)) problems.push(`IIFE ${i + 1} calls ${name}() declared only in IIFE ${j + 1}`);
            }
        });
    });
    assert.deepEqual(problems, []);
});

test('the song-start lock check goes through the window export', () => {
    assert.match(SRC, /const songLock = window\._aeSongToneLock;/);
    assert.match(SRC, /songLock\.get\(songKey\)/);
});
