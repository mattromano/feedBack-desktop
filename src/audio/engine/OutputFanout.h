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
// Called on the audio thread AFTER master gain, metering and the loop-ring
// write (those keep reading the first pair). No allocation, no locks.
//
// Every channel >= 2 is written on every block (copied or cleared), so stale
// data — e.g. the single-source fast path broadcasting guitar-only audio to
// all channels — never reaches the extra outputs.

#include <juce_audio_basics/juce_audio_basics.h>
#include <cstdint>

namespace slopsmith
{

// Bit `c` set = output channel `c` muted. Channels >= 64 are never muted.
inline bool outputChannelMuted(uint64_t mutedMask, int channel) noexcept
{
    return channel >= 0 && channel < 64 && ((mutedMask >> channel) & 1u) != 0;
}

inline void fanOutStereoMix(float* const* outputData, int numOutputChannels,
                            int numSamples, uint64_t mutedMask) noexcept
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
        if (haveStereo && ! outputChannelMuted(mutedMask, ch))
            juce::FloatVectorOperations::copy(dst, outputData[ch & 1], numSamples);
        else
            juce::FloatVectorOperations::clear(dst, numSamples);
    }

    // Mute the source pair last: the copies above still needed its samples.
    for (int ch = 0; ch < juce::jmin(numOutputChannels, 2); ++ch)
        if (outputData[ch] != nullptr && outputChannelMuted(mutedMask, ch))
            juce::FloatVectorOperations::clear(outputData[ch], numSamples);
}

} // namespace slopsmith
