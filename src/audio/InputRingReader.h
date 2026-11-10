#pragma once
#include <cstdint>
#include <vector>

// InputRingReader — the narrow slice of a capture chain that NoteVerifier needs:
// the post-input lock-free sample ring plus the device sample rate. Factored out
// of AudioEngine so the verifier reads ITS OWN source's ring rather than the
// engine's single global one — the precondition for N independent capture chains
// (a SourceChain per audio input). AudioEngine used to expose these directly and
// NoteVerifier held an `AudioEngine&`; now SourceChain implements this interface
// and owns one verifier. See SourceChain.h.
class InputRingReader
{
public:
    virtual ~InputRingReader() = default;

    // Most-recent N samples from the pre-gate input ring, zero-padded on the
    // left during cold start so the newest sample lands at out.back(). Off-
    // audio-thread safe (acquire-loads the ring write index).
    virtual std::vector<float> getInputFrame(int numSamples) const = 0;

    // Gapless consumption: copies every sample written since monotonic index
    // `fromIndex` into `out` and returns the current write index. See
    // AudioEngine::getInputSince (the original) for the full contract.
    virtual uint64_t getInputSince(uint64_t fromIndex, std::vector<float>& out) const = 0;

    // The live device sample rate the ring samples were captured at.
    virtual double getCurrentSampleRate() const = 0;

    // Capture timing of the newest input block: `ringIndex` is the ring index
    // just past its last sample, `wallMs` the juce hi-res millisecond counter
    // when that block's device callback started. false until a block lands.
    virtual bool getInputStamp(uint64_t& ringIndex, double& wallMs) const
    {
        (void) ringIndex; (void) wallMs;
        return false;
    }

    // How long before its block's callback the NEWEST sample of a block left
    // the converter (seconds): the device's reported input latency minus one
    // buffer (drivers report latency for the block's first sample).
    virtual double getCaptureLatencySec() const { return 0.0; }
};
