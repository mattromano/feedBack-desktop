#pragma once

// RingResidencyTrim — keeps the split-mode guitar ring from silently turning
// into a delay line.
//
// In split mode (input and output on two different endpoints, e.g. a USB
// guitar cable in + separate speakers out) the input callback pushes into a
// PackedStereoRing and the output callback drains it. The two devices run on
// independent hardware clocks. When the input clock is even a few ppm faster
// than the output clock, the surplus frames are never consumed: the ring
// fills until the producer laps it, and catchUpIfLapped() then holds it at
// FULL capacity for the rest of the session — kOutputRingFrames (4096) frames,
// ~85 ms at 48 kHz, added to every note the player hears. Startup order (input
// running before output starts draining) parks a backlog the same way.
//
// The fix is the classic minimum-residency trim: over a short window, track
// the smallest fill the ring ever had left after a drain. Those frames were
// never needed to ride out callback jitter, so they are pure latency; drop
// them (keeping a small slack) at the start of the next drain. Jitter can only
// make the observed minimum SMALLER, never larger, so the trim is
// conservative — it cannot cause an underflow the ring wouldn't already have
// had. Under steady drift the per-window drop is a frame or two.
//
// Single-thread use: only the output callback touches an instance. JUCE-free
// so tests/engine_units can drive it with plain numbers.

#include <algorithm>
#include <cstdint>
#include <limits>

namespace slopsmith {

struct RingResidencyTrim
{
    static constexpr uint64_t kNone = std::numeric_limits<uint64_t>::max();

    // Frames always left in the ring (~1.3 ms at 48 kHz) as jitter headroom.
    uint64_t slackFrames = 64;
    // Observation window length in frames (set from the sample rate).
    uint64_t windowFrames = 12000;

    uint64_t framesSeen  = 0;
    uint64_t minLeftover = kNone;
    uint64_t pendingDrop = 0;
    uint64_t totalDropped = 0;

    // Window of ~250 ms: long enough to span many input/output callback
    // phases (so the minimum is real), short enough that a startup backlog
    // is gone almost immediately.
    void prepare(double sampleRate) noexcept
    {
        const double sr = sampleRate > 0.0 ? sampleRate : 48000.0;
        windowFrames = std::max<uint64_t>(1, (uint64_t) (sr * 0.25));
        reset();
    }

    void reset() noexcept
    {
        framesSeen = 0;
        minLeftover = kNone;
        pendingDrop = 0;
    }

    // Call at the start of a drain, after the lap/resync guards. Returns how
    // many of the oldest `available` frames to skip before reading.
    uint64_t takeDrop(uint64_t available) noexcept
    {
        const uint64_t d = std::min(pendingDrop, available);
        pendingDrop = 0;
        totalDropped += d;
        return d;
    }

    // Call after the drain with what is still queued and the block length.
    void observe(uint64_t leftover, int blockFrames) noexcept
    {
        minLeftover = std::min(minLeftover, leftover);
        framesSeen += (uint64_t) std::max(0, blockFrames);
        if (framesSeen < windowFrames)
            return;
        if (minLeftover != kNone && minLeftover > slackFrames)
            pendingDrop = minLeftover - slackFrames;
        framesSeen = 0;
        minLeftover = kNone;
    }
};

} // namespace slopsmith
