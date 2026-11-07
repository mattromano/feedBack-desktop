#pragma once

// PlayheadModel — the song clock the NoteVerifier scores against, rebuilt from
// the renderer's playhead pushes (one per detect tick, over IPC).
//
// While playing it is a line: song(t) = c + rate * t / 1000 (t = wall ms).
//   rate  is MEASURED from the pushes (slope over up to 2 s), so a practice
//         speed (0.5x, 0.75x) is followed instead of assuming 1.0 — the old
//         `base + age` extrapolation drifted (1 - rate) * push interval.
//   c     is the max over the last 300 ms of (song_i - rate * t_i): every
//         push arrives LATE by its IPC delay, never early, so the fastest
//         push is the truest one and a slow push can't drag the clock back.
// A seek / loop wrap / resume (a push off the line by > kJumpSeconds) starts
// a fresh line. Paused: the last pushed song time. A push stream that
// stopped (> kStaleMs) freezes the clock where it was at the last push.
//
// JUCE-free and lock-free by itself: the owner serialises calls (NoteVerifier
// holds its lock). Unit-tested in tests/engine_units/playhead_model_test.cpp.

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace slopsmith {

class PlayheadModel
{
public:
    static constexpr double kJumpSeconds = 0.25;
    static constexpr double kStaleMs = 1000.0;
    static constexpr double kRateWindowMs = 2000.0;
    static constexpr double kRateMinSpanMs = 300.0;
    static constexpr double kOffsetWindowMs = 1000.0;

    void reset() { count = 0; playing = false; lastSong = 0.0; lastMs = 0.0; }

    void push(double song, bool isPlaying, double nowMs)
    {
        if (!isPlaying)
        {
            count = 0;
        }
        else
        {
            if (!playing || count == 0 || std::abs(song - (c + rate * nowMs / 1000.0)) > kJumpSeconds)
                count = 0;
            hist[head] = { song, nowMs };
            head = (head + 1) % kHistory;
            if (count < kHistory) ++count;

            // Rate: least-squares slope over the pushes of the last 2 s (two
            // endpoints alone would carry their IPC delays straight into it).
            int n = 0;
            double span = 0.0, sx = 0.0, sy = 0.0;
            for (int k = 0; k < count; ++k)
            {
                const Sample& p = at(k);
                if (nowMs - p.ms > kRateWindowMs) break;
                span = nowMs - p.ms;
                sx += p.ms - nowMs; sy += p.song - song; ++n;
            }
            if (n >= 3 && span >= kRateMinSpanMs)
            {
                const double mx = sx / n, my = sy / n;
                double sxx = 0.0, sxy = 0.0;
                for (int k = 0; k < n; ++k)
                {
                    const Sample& p = at(k);
                    const double dx = (p.ms - nowMs) - mx, dy = (p.song - song) - my;
                    sxx += dx * dx; sxy += dx * dy;
                }
                double r = sxx > 0.0 ? 1000.0 * sxy / sxx : NAN;
                // Speeds are set in whole percent (1.0, 0.75, 0.5 ...): an
                // estimate within 0.3% of one IS that speed. Snapping removes
                // the residual IPC-jitter slope error (0.1% ≈ 1 ms over 1 s).
                const double snapped = std::round(r * 100.0) / 100.0;
                if (std::abs(r - snapped) < 0.003) r = snapped;
                if (std::isfinite(r)) rate = std::min(4.0, std::max(0.05, r));
            }
            double best = -1e300;
            for (int k = 0; k < count; ++k)
            {
                const Sample& p = at(k);
                if (k > 0 && nowMs - p.ms > kOffsetWindowMs) break;
                best = std::max(best, p.song - rate * p.ms / 1000.0);
            }
            c = best;
        }
        playing = isPlaying;
        lastSong = song;
        lastMs = nowMs;
    }

    // The song time at wall time `wallMs` (which may be in the past, e.g.
    // when an input block was captured), evaluated at wall time `nowMs`.
    double songAt(double wallMs, double nowMs) const
    {
        if (!playing || count == 0) return lastSong;
        if (nowMs - lastMs > kStaleMs) return c + rate * lastMs / 1000.0;
        return c + rate * wallMs / 1000.0;
    }

    double getRate() const { return rate; }
    bool isPlaying() const { return playing; }

private:
    struct Sample { double song = 0.0; double ms = 0.0; };
    static constexpr int kHistory = 128;
    const Sample& at(int k) const { return hist[(head - 1 - k + kHistory) % kHistory]; }
    Sample hist[kHistory];
    int head = 0, count = 0;
    double rate = 1.0, c = 0.0;
    bool playing = false;
    double lastSong = 0.0, lastMs = 0.0;
};

// Song time at which input-ring sample `sampleIndex` left the converter.
// The capture stamp says ring index `stampIndex` (just past the newest sample
// of a block) arrived with a callback that started at song time
// `stampSongTime`; that newest sample was captured `captureLatencySec` before
// the callback, and every other sample sits its distance in samples away
// (signed: a sample from a later block is later). The playback rate scales
// sample distance into song time.
inline double onsetSongTime(double stampSongTime, uint64_t stampIndex, uint64_t sampleIndex,
                            double sampleRate, double captureLatencySec, double rate)
{
    const double samplesBefore = (double) stampIndex - (double) sampleIndex;
    return stampSongTime - (captureLatencySec + samplesBefore / sampleRate) * rate;
}

} // namespace slopsmith
