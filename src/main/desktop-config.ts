// Desktop config — the main process's own settings file,
// <userData>/slopsmith-desktop.json (soundfont quality, LAN access, window
// geometry, fullscreen, pane pop-out windows). Read by main.ts, pane-hosts.ts,
// python.ts and soundfont-manager.ts. Moved out of soundfont-manager.ts
// unchanged (untangler I-002).

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

export function setDesktopConfig(patch: Partial<DesktopConfig>): void {
    const current = getDesktopConfig();
    const next = { ...current, ...patch };
    const tmp = configPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, configPath());
}
