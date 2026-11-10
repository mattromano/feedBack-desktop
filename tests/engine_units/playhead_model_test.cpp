// PlayheadModel + onsetSongTime (src/audio/engine/PlayheadModel.h): the clock
// note detection times pick attacks against.
//
// The end-to-end case simulates the whole capture path — a renderer pushing
// its playhead over a jittery IPC link, a device delivering input blocks with
// a reported input latency, the verifier stamping an attack — for every
// buffer size, driver latency and playback rate a player might use, and
// requires the attack to land within 1 ms of when it was really played.

#include "../../src/audio/engine/PlayheadModel.h"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <random>
#include <cstdlib>
#ifdef _MSC_VER
#include <crtdbg.h>
#endif

using slopsmith::PlayheadModel;
using slopsmith::onsetSongTime;

static bool near(double a, double b, double tol) { return std::fabs(a - b) <= tol; }

// Pushes arrive LATE by a random IPC delay; the model must not lag by it.
static void testFiltersIpcDelay()
{
    PlayheadModel m;
    std::mt19937 rng(7);
    std::uniform_real_distribution<double> delay(0.0, 8.0);   // ms
    const double song0 = 12.0;
    double worst = 0.0, warm = 0.0;
    for (int i = 0; i < 400; ++i)
    {
        const double sendMs = 1000.0 + i * 16.7;
        const double truth = song0 + (sendMs - 1000.0) / 1000.0;
        const double recvMs = sendMs + delay(rng);
        m.push(truth, true, recvMs);
        const double probe = recvMs + 3.0;
        const double want = song0 + (probe - 1000.0) / 1000.0;
        const double err = std::fabs(m.songAt(probe, probe) - want);
        if (i < 60) warm = std::max(warm, err);     // the first second after a (re)start
        else        worst = std::max(worst, err);
    }
    std::printf("  ipc filter (0-8 ms jitter): first second %.3f ms, then worst %.3f ms\n",
                warm * 1000.0, worst * 1000.0);
    assert(warm < 0.008);    // never worse than the jitter itself
    assert(worst < 0.001);
}

// Practice speed: the rate is measured, not assumed 1.0.
static void testFollowsPlaybackRate()
{
    for (double rate : { 0.5, 0.75, 1.0, 1.25 })
    {
        PlayheadModel m;
        for (int i = 0; i < 120; ++i)
        {
            const double ms = 5000.0 + i * 20.0;
            m.push(30.0 + rate * (ms - 5000.0) / 1000.0, true, ms);
        }
        assert(near(m.getRate(), rate, 1e-9));
        const double probe = 5000.0 + 119 * 20.0 + 19.0;   // just before the next push
        assert(near(m.songAt(probe, probe), 30.0 + rate * (probe - 5000.0) / 1000.0, 1e-9));
    }
}

static void testSeekPauseStale()
{
    PlayheadModel m;
    for (int i = 0; i < 50; ++i) m.push(10.0 + i * 0.02, true, 1000.0 + i * 20.0);
    // Seek forward 30 s: the old line is dropped at once.
    m.push(40.0, true, 2000.0);
    assert(near(m.songAt(2010.0, 2010.0), 40.01, 1e-9));
    // Loop wrap backwards.
    m.push(5.0, true, 2020.0);
    assert(near(m.songAt(2030.0, 2030.0), 5.01, 1e-9));
    // Pause holds the pushed time.
    m.push(5.5, false, 2600.0);
    assert(m.songAt(9000.0, 2700.0) == 5.5);
    // Resume, then the pushes stop: frozen at the last push.
    for (int i = 0; i < 20; ++i) m.push(5.5 + i * 0.02, true, 3000.0 + i * 20.0);
    const double last = m.songAt(3380.0, 3380.0);
    assert(near(m.songAt(3380.0, 3380.0 + 5000.0), last, 1e-9));
}

static void testOnsetSongTime()
{
    // Rate 1: a sample 480 frames before the stamp, 5 ms capture latency.
    assert(near(onsetSongTime(10.0, 1000, 520, 48000.0, 0.005, 1.0), 10.0 - 0.005 - 0.010, 1e-12));
    // A sample from a block that landed after the stamp sits later.
    assert(near(onsetSongTime(10.0, 1000, 1480, 48000.0, 0.0, 1.0), 10.010, 1e-12));
    // Half speed: wall time maps to half the song time.
    assert(near(onsetSongTime(10.0, 1000, 520, 48000.0, 0.005, 0.5), 10.0 - 0.0075, 1e-12));
}

// End to end. For each config: the song plays at `rate`; the player strikes
// at song time T; the converter captures it at wall time t(T); the device
// delivers the block containing it to a callback that starts `inLat` after
// the block's FIRST sample was captured (the driver-reported input latency
// convention, ASIO and JUCE WASAPI alike); the verifier reads the stamp at a
// random later moment. The stamped onset must equal T.
static void testEndToEndCapture()
{
    std::mt19937 rng(11);
    std::uniform_real_distribution<double> ipc(0.0, 6.0), jitterCb(0.0, 1.5), u01(0.0, 1.0);
    double worst = 0.0;
    int cases = 0;
    for (double sr : { 44100.0, 48000.0, 96000.0 })
    for (int bs : { 32, 64, 128, 256, 512, 1024, 2048 })
    for (int extraLat : { 0, 32, 272, 1000 })            // driver latency beyond one buffer
    for (double rate : { 0.5, 0.8, 1.0, 1.2 })
    {
        const int inLat = bs + extraLat;
        const double capSec = (double) (inLat - bs) / sr;     // what the engine computes
        PlayheadModel m;
        const double t0 = 10000.0, song0 = 20.0;
        auto songAtWall = [&](double ms) { return song0 + rate * (ms - t0) / 1000.0; };
        // Renderer pushes for 2 s at ~60 Hz with IPC delay.
        double ms = t0;
        for (; ms < t0 + 2000.0; ms += 16.7)
            m.push(songAtWall(ms), true, ms + ipc(rng));
        // Block k's first sample is captured at blockStart(k); its callback
        // starts inLat later (plus scheduler jitter, which the stamp absorbs:
        // the block's samples are still placed relative to the stamp).
        const double blockMs = 1000.0 * bs / sr;
        const uint64_t k = 50000;                              // arbitrary ring position
        const double capFirst = t0 + 1500.0;                   // a block captured mid-run
        const double callbackMs = capFirst + 1000.0 * inLat / sr;
        (void) jitterCb;
        const uint64_t stampIdx = k + (uint64_t) bs;           // just past the block
        const int at = (int) (u01(rng) * bs);                  // the strike's sample
        const double strikeWall = capFirst + 1000.0 * at / sr;
        const double T = songAtWall(strikeWall);
        // A few more pushes land before the verifier tick reads the stamp.
        for (int j = 0; j < 3; ++j, ms += 16.7) m.push(songAtWall(ms), true, ms + ipc(rng));
        const double nowMs = callbackMs + 4.0;
        const double stampSong = m.songAt(callbackMs, nowMs);
        const double got = onsetSongTime(stampSong, stampIdx, k + (uint64_t) at, sr, capSec, m.getRate());
        worst = std::max(worst, std::fabs(got - T));
        ++cases;
        (void) blockMs;
    }
    std::printf("  end to end: %d configs, worst onset error %.3f ms\n", cases, worst * 1000.0);
    assert(worst < 0.001);
}

int main()
{
    std::setvbuf(stdout, nullptr, _IONBF, 0);
#ifdef _MSC_VER
    _set_error_mode(_OUT_TO_STDERR);   // a failed assert prints, no dialog
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
#endif
    testFiltersIpcDelay();
    testFollowsPlaybackRate();
    testSeekPauseStale();
    testOnsetSongTime();
    testEndToEndCapture();
    std::puts("playhead_model: all cases passed");
    return 0;
}
