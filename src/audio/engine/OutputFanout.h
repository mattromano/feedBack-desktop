#pragma once

// Multi-output fan-out ("Play on multiple outputs").
//
// The engine always renders one stereo mix into output channels 0/1. When the
// device was opened with more outputs (e.g. ASIO4ALL exposing a headset AND
// the Realtek speakers), every further pair gets a copy of that mix: even
// channels take L, odd channels take R. Then any channel whose bit is set in
// `mutedMask` is silenced — pair 0 included — so the user can switch between
// outputs live without reopening the device.
//
// A channel whose mute state changed since the previous block (`prevMask`) is
// faded over this one block instead of cut, so a live toggle doesn't click.
// `prevMask` is owned by the calling audio callback: it is updated to
// `mutedMask` on return, and set to the current mask before the device starts.
//
// Called on the audio thread AFTER master gain, metering and the loop-ring
// write (those keep reading the first pair). No allocation, no locks, no JUCE
// (so tests/engine_units can test it directly).
//
// Every channel >= 2 is written on every block (copied, faded or cleared), so
// stale data — e.g. the single-source fast path broadcasting guitar-only audio
// to all channels — never reaches the extra outputs.

#include <algorithm>
#include <cstdint>

namespace slopsmith
{

// Bit `c` set = output channel `c` muted. Channels >= 64 are never muted.
inline bool outputChannelMuted(uint64_t mutedMask, int channel) noexcept
{
    return channel >= 0 && channel < 64 && ((mutedMask >> channel) & 1u) != 0;
}

// dst[i] = src[i] * gain ramping linearly from g0 to g1 across the block.
// dst may alias src (the source pair is faded in place).
inline void rampOutputChannel(float* dst, const float* src, int numSamples,
                              float g0, float g1) noexcept
{
    const float step = (g1 - g0) / (float) numSamples;
    float g = g0;
    for (int i = 0; i < numSamples; ++i)
    {
        g += step; // ends exactly on g1 at the last sample
        dst[i] = src[i] * g;
    }
}

inline void fanOutStereoMix(float* const* outputData, int numOutputChannels,
                            int numSamples, uint64_t mutedMask,
                            uint64_t& prevMask) noexcept
{
    if (outputData == nullptr || numOutputChannels <= 0 || numSamples <= 0)
        return;

    const bool haveStereo = numOutputChannels >= 2
                            && outputData[0] != nullptr && outputData[1] != nullptr;

    for (int ch = 2; ch < numOutputChannels; ++ch)
    {
        float* const dst = outputData[ch];
        if (dst == nullptr)
            continue;
        const bool mutedNow = outputChannelMuted(mutedMask, ch);
        const bool mutedBefore = outputChannelMuted(prevMask, ch);
        if (! haveStereo || (mutedNow && mutedBefore))
            std::fill(dst, dst + numSamples, 0.0f);
        else if (! mutedNow && ! mutedBefore)
            std::copy(outputData[ch & 1], outputData[ch & 1] + numSamples, dst);
        else
            rampOutputChannel(dst, outputData[ch & 1], numSamples,
                              mutedBefore ? 0.0f : 1.0f, mutedNow ? 0.0f : 1.0f);
    }

    // The source pair last: the copies above still needed its samples.
    for (int ch = 0; ch < std::min(numOutputChannels, 2); ++ch)
    {
        float* const dst = outputData[ch];
        if (dst == nullptr)
            continue;
        const bool mutedNow = outputChannelMuted(mutedMask, ch);
        const bool mutedBefore = outputChannelMuted(prevMask, ch);
        if (mutedNow && mutedBefore)
            std::fill(dst, dst + numSamples, 0.0f);
        else if (mutedNow != mutedBefore)
            rampOutputChannel(dst, dst, numSamples,
                              mutedBefore ? 0.0f : 1.0f, mutedNow ? 0.0f : 1.0f);
    }

    prevMask = mutedMask;
}

} // namespace slopsmith
