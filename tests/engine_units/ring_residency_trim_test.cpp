// RingResidencyTrim: the split-mode guitar ring must not hold latency.
// Simulates the two-clock producer/consumer the engine runs (input callback
// pushes, output callback drains) with a plain counter as the ring fill.

#include "../../src/audio/engine/RingResidencyTrim.h"

#include <cstdint>
#include <cstdio>

using slopsmith::RingResidencyTrim;

namespace {

int g_failed = 0;

void check(bool condition, const char* expression, const char* file, int line)
{
    if (condition)
        return;
    ++g_failed;
    std::fprintf(stderr, "  FAIL: %s  (%s:%d)\n", expression, file, line);
}

#define CHECK(condition) check((condition), #condition, __FILE__, __LINE__)

constexpr uint64_t kCap = 4096;

struct Sim
{
    RingResidencyTrim trim;
    uint64_t fill = 0;
    uint64_t underflows = 0;
    uint64_t maxFillLastSecond = 0;
    bool useTrim = true;

    // One output callback, mirroring AudioEngine::audioOutputCallback.
    void drain(int block)
    {
        if (fill > kCap) fill = kCap;                 // catchUpIfLapped
        if (useTrim) fill -= trim.takeDrop(fill);
        const uint64_t consume = fill < (uint64_t) block ? fill : (uint64_t) block;
        if (consume < (uint64_t) block) ++underflows;
        fill -= consume;
        if (useTrim) trim.observe(fill, block);
    }
};

// Run `seconds` of audio with input at inRate and output at outRate (both
// nominally 48 kHz), 480-frame blocks on each side, interleaving callbacks by
// their real-time deadlines. `backlog` frames are queued before output starts.
Sim run(double inRate, double outRate, double seconds, uint64_t backlog, bool useTrim)
{
    Sim s;
    s.useTrim = useTrim;
    s.trim.prepare(48000.0);
    s.fill = backlog;
    const int block = 480;
    double tIn = 0.0, tOut = 0.0;
    const double dIn = block / inRate, dOut = block / outRate;
    while (tOut < seconds)
    {
        if (tIn <= tOut) { s.fill += block; tIn += dIn; }
        else
        {
            s.drain(block);
            tOut += dOut;
            if (tOut > seconds - 1.0 && s.fill > s.maxFillLastSecond)
                s.maxFillLastSecond = s.fill;
        }
    }
    return s;
}

} // namespace

int main()
{
    // Without the trim, a 100 ppm faster input clock walks the ring up to
    // full capacity over a long session: ~85 ms of extra guitar latency.
    {
        const Sim s = run(48004.8, 48000.0, 900.0, 0, false);
        CHECK(s.maxFillLastSecond > 3500);   // capacity minus one drained block
    }
    // With the trim it stays within one block + slack, and never underflows.
    {
        const Sim s = run(48004.8, 48000.0, 900.0, 0, true);
        CHECK(s.maxFillLastSecond <= 480 + 64 + 8);
        CHECK(s.underflows == 0);
        CHECK(s.trim.totalDropped > 0);
    }
    // A startup backlog (input running before the output drains) is cleared
    // within the first window instead of being kept forever.
    {
        const Sim s = run(48000.0, 48000.0, 2.0, 3000, true);
        CHECK(s.maxFillLastSecond <= 480 + 64 + 8);
        CHECK(s.underflows == 0);
        CHECK(s.trim.totalDropped >= 3000 - 64);
    }
    // Output faster than input: the ring runs dry by itself (underflows are
    // that case's existing behaviour); the trim must not add any drops.
    {
        const Sim s = run(48000.0, 48004.8, 60.0, 0, true);
        CHECK(s.trim.totalDropped == 0);
    }
    // Matched clocks, no backlog: nothing to trim.
    {
        const Sim s = run(48000.0, 48000.0, 60.0, 0, true);
        CHECK(s.trim.totalDropped == 0);
        CHECK(s.underflows == 0);
    }
    // takeDrop never skips more than is queued.
    {
        RingResidencyTrim t;
        t.prepare(48000.0);
        t.pendingDrop = 1000;
        CHECK(t.takeDrop(300) == 300);
        CHECK(t.takeDrop(300) == 0);
    }

    if (g_failed)
    {
        std::fprintf(stderr, "ring_residency_trim: %d check(s) failed\n", g_failed);
        return 1;
    }
    std::printf("ring_residency_trim: all checks passed\n");
    return 0;
}
