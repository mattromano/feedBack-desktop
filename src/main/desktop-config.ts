// Desktop config — the main process's own settings file,
// <userData>/slopsmith-desktop.json (soundfont quality, LAN access, window
// geometry, fullscreen, pane pop-out windows, multi-output audio). Read by
// main.ts, pane-hosts.ts, python.ts, soundfont-manager.ts and audio-bridge.ts.
// Moved out of soundfont-manager.ts unchanged (untangler I-002).

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { SavedWindowBounds } from './window-bounds';

export type SoundfontQuality = 'default' | 'high';

export interface DesktopConfig {
    soundfontQuality?: SoundfontQuality;
    // When true, the Python backend binds 0.0.0.0 (LAN-reachable) instead of
    // 127.0.0.1, so other devices on the network can reach the library / sync
    // room. Opt-in (default loopback) — see python.ts and issue #441.
    lanAccess?: boolean;
    // Last main-window geometry, restored (after sanitization against the
    // current display layout) on next launch — see window-bounds.ts.
    windowBounds?: SavedWindowBounds;
    // When true, the main window launches in fullscreen and the System-settings
    // toggle that drives it is shown. Opt-in (default off) — this deliberately
    // reverses createWindow()'s historical "never launch fullscreen" default,
    // but only for users who ask for it. Persisted here (not renderer
    // localStorage) because the main process must read it at window creation,
    // before the renderer exists.
    startFullscreen?: boolean;
    // Per-pane pop-out window geometry, keyed by pane id, plus its always-on-top
    // flag. Sanitized against the display layout on restore, exactly like
    // windowBounds — see pane-hosts.ts. Lives in the desktop config rather than
    // the renderer's localStorage because localStorage is shared with the pane
    // windows themselves (same origin), and a second writer there would race.
    paneWindows?: Record<string, SavedPaneWindow>;
    // "Play on multiple outputs": when true the audio engine opens EVERY output
    // channel of the device (e.g. ASIO4ALL with a headset and the Realtek
    // speakers both ticked) and plays the stereo mix on each pair, instead of
    // only the first pair. Opt-in (default off). Read by audio-bridge.ts on
    // every setDevice; toggling it reopens the device.
    multiOutput?: boolean;
    // Output channel names (as the device advertises them) silenced while
    // multiOutput is on, per output device ("<outputType>|<outputDevice>").
    // Keyed by name, not index, because ASIO4ALL reorders channels when
    // devices are ticked in its panel; per device because some backends name
    // channels generically ("Output channel 1"). Applied live (no reopen).
    mutedOutputChannelsByDevice?: Record<string, string[]>;
}

export interface SavedPaneWindow {
    bounds?: SavedWindowBounds;
    alwaysOnTop?: boolean;
}

function configPath(): string {
    return path.join(app.getPath('userData'), 'slopsmith-desktop.json');
}

export function getDesktopConfig(): DesktopConfig {
    try {
        return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as DesktopConfig;
    } catch {
        return {};
    }
}

// An unreadable config would otherwise be replaced by just the next patch,
// silently dropping every other setting (window bounds, LAN access, ...).
// Keep the bad bytes next to it as slopsmith-desktop.json.corrupt so they can
// be recovered by hand. Reads still treat it as {} exactly as before.
function backupIfCorrupt(file: string): void {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    } catch {
        return; // missing or unreadable: nothing to keep
    }
    try {
        JSON.parse(raw);
    } catch {
        try {
            fs.writeFileSync(file + '.corrupt', raw);
            console.warn(`[desktop-config] ${file} was not valid JSON; kept a copy as ${file}.corrupt`);
        } catch { /* best effort */ }
    }
}

export function setDesktopConfig(patch: Partial<DesktopConfig>): void {
    backupIfCorrupt(configPath());
    const current = getDesktopConfig();
    const next = { ...current, ...patch };
    const tmp = configPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, configPath());
}
