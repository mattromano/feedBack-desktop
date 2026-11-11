// Live Retune: shift the pitch of the guitar you're playing.
//
// The shift runs in the native engine (LivePitchShifter in SourceChain), right after input gain,
// so note detection hears the shifted guitar and the amp/IR chain gets the retuned DI. The tuner
// keeps reading the dry strings. Control is the desktop bridge's
// audio.setLivePitch({ semitones, cents, windowMs }); status (applied cents, window, added latency)
// comes back from audio.getLivePitch(). An app whose engine lacks the shifter has no
// setLivePitch / reports supported:false, which is how "not supported" is shown.
//
// "Match song" adds the current song's recording offset (song_cents plugin: window.__songCents
// .current = { cents, source }, change event 'songcents:change'), e.g. +45c on a sharp record, so
// a standard-tuned guitar plays in tune with the record.
//
// "Follow song" adds the current chart's tuning when every string is offset by the same whole
// number of semitones (Eb standard = -1 on all strings, D standard = -2, ...), so a guitar kept
// in E standard plays along with a down-tuned song without retuning. Uneven tunings (Drop D)
// can't be matched by a whole-guitar shift and are left alone. Off by default: a player who
// physically retunes would otherwise be shifted twice.
//
// The control is appended to #player-controls; the v3 player re-homes plugin controls from there
// into its Plugins popover.
(function () {
    'use strict';
    if (window.__liveRetune) return;
    const KEY = 'liveRetune';
    const MAX_ST = 5;
    const MODES = [
        { id: 'tight', label: 'Tight', ms: 8 },
        { id: 'balanced', label: 'Balanced', ms: 14 },
        { id: 'smooth', label: 'Smooth', ms: 22 },
    ];
    const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

    function load() {
        let s = {};
        try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { /* ignore */ }
        const st = Math.max(-MAX_ST, Math.min(MAX_ST, Math.round(Number(s.semitones) || 0)));
        const c = Math.max(-100, Math.min(100, Math.round(Number(s.cents) || 0)));
        const mode = MODES.some((m) => m.id === s.mode) ? s.mode : 'balanced';
        return { semitones: st, cents: c, mode, match: !!s.match, follow: !!s.follow };
    }

    const state = load();
    let supported = null;      // null = unknown yet
    let latencyMs = 0;

    const api = () => {
        const d = window.feedBackDesktop || window.slopsmithDesktop;
        return d && d.audio;
    };
    // Browser (no desktop bridge): nothing to drive.
    if (!api()) return;

    // The current song's recording offset when "Match song" is on (0 when unknown).
    function matchCents() {
        const cur = window.__songCents && window.__songCents.current;
        return state.match && cur && typeof cur.cents === 'number' ? Math.round(cur.cents) : 0;
    }
    // The song's uniform tuning offset in semitones when "Follow song" is on (0 when off, when no
    // song is loaded, or when the strings aren't all shifted by the same amount).
    function songTuningSt(tuning) {
        if (!Array.isArray(tuning) || tuning.length === 0) return 0;
        const first = Number(tuning[0]);
        if (!Number.isInteger(first) || first === 0) return 0;
        if (!tuning.every((t) => Number(t) === first)) return 0;
        return Math.max(-MAX_ST, Math.min(MAX_ST, first));
    }
    function followSt() {
        if (!state.follow) return 0;
        const hw = window.highway || window._slopsmithHighway;
        let info = null;
        try { info = hw && typeof hw.getSongInfo === 'function' ? hw.getSongInfo() : null; } catch (_) { info = null; }
        return songTuningSt(info && info.tuning);
    }
    const shiftSt = () => Math.max(-MAX_ST, Math.min(MAX_ST, state.semitones + followSt()));
    const totalCents = () => shiftSt() * 100 + state.cents + matchCents();
    const windowMs = () => (MODES.find((m) => m.id === state.mode) || MODES[1]).ms;

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
    }

    function apply() {
        const a = api();
        if (!a || typeof a.setLivePitch !== 'function') { supported = false; return; }
        Promise.resolve(a.setLivePitch({
            semitones: shiftSt(),
            cents: state.cents + matchCents(),
            windowMs: windowMs(),
        })).catch(() => {});
    }

    function set(patch) {
        Object.assign(state, patch);
        state.semitones = Math.max(-MAX_ST, Math.min(MAX_ST, state.semitones));
        state.cents = Math.max(-100, Math.min(100, state.cents));
        save();
        apply();
        render();
    }

    // E standard's low string after the shift, e.g. -1 st -> "Eb".
    function tuningName() {
        const t = totalCents();
        if (t === 0) return 'standard';
        const st = Math.round(t / 100);
        const rest = t - st * 100;
        const name = NOTES[((4 + st) % 12 + 12) % 12];
        return rest ? `${name} ${rest > 0 ? '+' : ''}${rest}c` : name;
    }

    function render() {
        const st = document.getElementById('lr-st');
        const sl = document.getElementById('lr-cents');
        const cl = document.getElementById('lr-cents-label');
        const md = document.getElementById('lr-mode');
        const info = document.getElementById('lr-info');
        if (!st) return;
        st.textContent = (state.semitones > 0 ? '+' : '') + state.semitones + ' st';
        if (Number(sl.value) !== state.cents) sl.value = String(state.cents);
        cl.textContent = (state.cents > 0 ? '+' : '') + state.cents + 'c';
        if (md.value !== state.mode) md.value = state.mode;
        const fb = document.getElementById('lr-follow');
        if (fb) {
            const fst = followSt();
            fb.textContent = 'Follow song' + (state.follow && fst ? ` ${fst > 0 ? '+' : ''}${fst} st` : '');
            fb.setAttribute('aria-pressed', state.follow ? 'true' : 'false');
            fb.style.background = state.follow ? 'rgba(14,116,144,.45)' : '';
            fb.style.color = state.follow ? '#e0f2fe' : '';
            fb.title = 'Shift by the song’s tuning when every string is down (or up) by the same amount '
                + '(Eb, D, C# standard…), so an E-standard guitar plays along without retuning. Drop tunings are left alone.';
        }
        const mb = document.getElementById('lr-match');
        if (mb) {
            const cur = window.__songCents && window.__songCents.current;
            const sc = !cur ? '' : cur.source === 'pending' ? ' …'
                : typeof cur.cents === 'number' ? ' ' + (cur.cents > 0 ? '+' : '') + Math.round(cur.cents) + 'c' : ' ?';
            mb.textContent = 'Match song' + sc;
            mb.setAttribute('aria-pressed', state.match ? 'true' : 'false');
            mb.style.background = state.match ? 'rgba(14,116,144,.45)' : '';
            mb.style.color = state.match ? '#e0f2fe' : '';
            mb.title = !window.__songCents ? 'Needs the Song Cents plugin.'
                : 'Shift by the recording’s own offset from the chart tuning so a standard-tuned guitar sounds in tune with the record'
                  + (cur && cur.source && cur.source !== 'pending' ? ` (${cur.source === 'audio' ? 'measured from the recording' : 'from the chart'})` : '') + '.';
        }
        if (supported === false) {
            info.textContent = 'not supported';
            info.title = 'This app’s audio engine has no live retune.';
        } else {
            const lat = totalCents() !== 0 && latencyMs > 0 ? ` +${latencyMs.toFixed(0)}ms` : '';
            info.textContent = tuningName() + lat;
            info.title = 'Low string after the shift, and the delay the retune adds.';
        }
        const wrap = document.getElementById('lr-ctl');
        if (wrap) wrap.classList.toggle('lr-on', totalCents() !== 0);
    }

    function btn(text, title, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        b.className = 'px-1.5 rounded bg-dark-600 hover:bg-dark-500 text-xs text-gray-300';
        b.addEventListener('click', onClick);
        return b;
    }

    function ensure() {
        const bar = document.getElementById('player-controls');
        if (!bar || document.getElementById('lr-ctl')) return;
        const wrap = document.createElement('span');
        wrap.id = 'lr-ctl';
        wrap.className = 'inline-flex items-center gap-1 text-xs text-gray-500';

        const name = document.createElement('span');
        name.textContent = 'Retune';
        name.title = 'Shift the pitch of what you play (semitones + cents). Note detection follows it; the tuner shows your real strings.';

        const down = btn('−', 'Down a semitone', () => set({ semitones: state.semitones - 1 }));
        const st = document.createElement('span');
        st.id = 'lr-st';
        st.className = 'w-9 text-center tabular-nums';
        const up = btn('+', 'Up a semitone', () => set({ semitones: state.semitones + 1 }));

        const sl = document.createElement('input');
        sl.type = 'range';
        sl.id = 'lr-cents';
        sl.min = '-100'; sl.max = '100'; sl.step = '1';
        sl.className = 'w-20 accent-accent slider-input';
        sl.title = 'Fine tune in cents. Double-click to reset.';
        sl.setAttribute('aria-label', 'Retune cents');
        sl.addEventListener('input', () => set({ cents: Number(sl.value) }));
        sl.addEventListener('dblclick', () => set({ cents: 0 }));
        const cl = document.createElement('span');
        cl.id = 'lr-cents-label';
        cl.className = 'w-9 tabular-nums';

        const md = document.createElement('select');
        md.id = 'lr-mode';
        md.className = 'bg-dark-600 rounded text-xs text-gray-300';
        md.title = 'Tight: least delay. Smooth: cleanest on big shifts and chords.';
        md.setAttribute('aria-label', 'Retune mode');
        for (const m of MODES) {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.label;
            md.append(o);
        }
        md.addEventListener('change', () => set({ mode: md.value }));

        const reset = btn('0', 'Back to standard (no shift)', () => set({ semitones: 0, cents: 0 }));
        const match = btn('Match song', '', () => set({ match: !state.match }));
        match.id = 'lr-match';
        const follow = btn('Follow song', '', () => set({ follow: !state.follow }));
        follow.id = 'lr-follow';
        const info = document.createElement('span');
        info.id = 'lr-info';
        info.className = 'tabular-nums text-gray-400';

        wrap.append(name, down, st, up, sl, cl, md, reset, follow, match, info);
        bar.append(wrap);
        render();
    }

    // Keep the engine in step: re-send after an engine restart or device change (the native state
    // resets to 0), and pick up the measured latency.
    async function poll() {
        const a = api();
        if (!a || typeof a.getLivePitch !== 'function') {
            supported = false;
            render();
            return;
        }
        try {
            const lp = await a.getLivePitch();
            supported = !!(lp && lp.supported);
            if (supported) {
                latencyMs = Number(lp.latencyMs) || 0;
                // The engine clamps the total to +/-500 cents.
                const want = Math.max(-500, Math.min(500, totalCents()));
                if (Math.round(Number(lp.cents)) !== want
                    || Math.round(Number(lp.windowMs)) !== windowMs()) apply();
            }
        } catch (_) { /* ignore */ }
        render();
    }

    // ── Instrument-menu section ("Shift my guitar") ────────────────────────
    // The core's v3 guitar dropdown (static/v3/badges.js) takes extra sections via
    // v3Badges.registerMenuSection. This one drives the same state as the player
    // bar: pick what the guitar should SOUND as and the engine shifts the signal;
    // the strings (and the tuner) stay where they are.
    const escText = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // What the strings are tuned to (the host's working tuning), as offsets.
    function guitarOffsets() {
        const wt = window.feedBack && window.feedBack.workingTuning;
        let st = null;
        try { st = wt && typeof wt.get === 'function' ? wt.get() : null; } catch (_) { st = null; }
        const n = (st && Number(st.stringCount)) || 6;
        const off = st && Array.isArray(st.offsets) ? st.offsets : [];
        const out = [];
        for (let i = 0; i < n; i++) out.push(Number.isFinite(Number(off[i])) ? Number(off[i]) : 0);
        return out;
    }
    // Name of the guitar's tuning moved by `st` semitones, e.g. E Standard -2 -> "D Standard".
    function shiftedTuningName(offsets, st) {
        const moved = offsets.map((o) => o + st);
        const nameFor = window.displayTuningName || (window.feedBack && window.feedBack.displayTuningName);
        const name = typeof nameFor === 'function' ? nameFor(null, moved) : '';
        if (name && name !== 'Custom Tuning') return name;
        return st === 0 ? 'No shift' : `${st > 0 ? '+' : ''}${st} st`;
    }
    function renderMenuSection(slot, ctx) {
        const base = guitarOffsets();
        const cur = state.semitones;
        const fst = followSt();
        const pill = (attr, label, active, title) => '<button type="button" ' + attr + ' title="' + escText(title) + '" class="px-2 py-1 rounded-md text-xs ' +
            (active ? 'bg-fb-primary text-white' : 'bg-gray-800/50 text-fb-textDim hover:text-fb-text') + '">' + escText(label) + '</button>';
        let opts = '';
        for (let st = -MAX_ST; st <= MAX_ST; st++) {
            opts += '<option value="' + st + '"' + (st === cur ? ' selected' : '') + '>' +
                escText(shiftedTuningName(base, st) + (st ? ` (${st > 0 ? '+' : ''}${st})` : '')) + '</option>';
        }
        const status = supported === false ? 'Not supported by this audio engine'
            : (shiftSt() || state.cents || matchCents())
                ? 'Sounding as ' + shiftedTuningName(base, shiftSt()) + (state.cents ? ` ${state.cents > 0 ? '+' : ''}${state.cents}c` : '')
                : 'No shift';
        slot.innerHTML = '<div class="pt-3 border-t border-fb-border/40 space-y-2">' +
            '<div><div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim">Shift my guitar</div>' +
            '<div class="text-xs font-semibold truncate ' + (shiftSt() ? 'text-amber-400' : 'text-fb-text') + '" data-lr-status>' + escText(status) + '</div></div>' +
            '<div class="flex items-center gap-1">' +
            pill('data-lr-down', '−', false, 'Down a semitone') +
            '<select data-lr-sound-as title="Sound as (the strings stay where they are)" class="flex-1 min-w-0 bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-xs text-fb-text outline-none focus:border-fb-primary">' + opts + '</select>' +
            pill('data-lr-up', '+', false, 'Up a semitone') +
            '</div>' +
            '<div class="flex flex-wrap gap-1">' +
            pill('data-lr-follow', 'Follow song' + (state.follow && fst ? ` ${fst > 0 ? '+' : ''}${fst}` : ''), state.follow,
                'Also shift by the song’s tuning when every string is down (or up) by the same amount, so a guitar in E plays Eb/D songs without retuning.') +
            (cur || state.cents ? pill('data-lr-zero', 'No shift', false, 'Back to no shift') : '') +
            '</div></div>';
        const setAndRefresh = (patch) => { set(patch); ctx.refresh(); };
        slot.querySelector('[data-lr-sound-as]').addEventListener('change', (e) => setAndRefresh({ semitones: Number(e.target.value) }));
        slot.querySelector('[data-lr-down]').addEventListener('click', () => setAndRefresh({ semitones: state.semitones - 1 }));
        slot.querySelector('[data-lr-up]').addEventListener('click', () => setAndRefresh({ semitones: state.semitones + 1 }));
        slot.querySelector('[data-lr-follow]').addEventListener('click', () => setAndRefresh({ follow: !state.follow }));
        const zero = slot.querySelector('[data-lr-zero]');
        if (zero) zero.addEventListener('click', () => setAndRefresh({ semitones: 0, cents: 0 }));
    }
    (function registerMenuSection() {
        const section = { id: 'live-retune-shift', render: renderMenuSection, order: 10 };
        if (window.v3Badges && typeof window.v3Badges.registerMenuSection === 'function') {
            window.v3Badges.registerMenuSection(section.id, section.render, section);
        } else {
            window._v3BadgesPendingSections = window._v3BadgesPendingSections || [];
            window._v3BadgesPendingSections.push(section);
        }
    })();

    window.__liveRetune = { state, set, apply, songTuningSt, followSt, shiftSt, shiftedTuningName, renderMenuSection };
    window.addEventListener('songcents:change', () => { apply(); render(); });

    const bus = window.feedBack || window.slopsmith;
    if (bus && bus.on) bus.on('song:loaded', () => { ensure(); apply(); });
    setInterval(ensure, 1500);
    setInterval(poll, 2000);
    ensure();
    apply();
    poll();
})();
