#pragma once
#include <atomic>
#include <cstdint>
#include <vector>

// LivePitchShifter — low-latency pitch shift for the live (monitored) guitar.
//
// Time-domain granular delay-line shifter: the input is written into a short
// circular delay line and read back by two taps that move at `ratio` samples per
// output sample, so each tap's delay drifts by (1 - ratio) per sample. Each tap
// lives for one grain, faded with sin^2 / cos^2 windows that sum to exactly 1,
// and restarts while silent. When a tap restarts, its start delay is chosen by
// a WSOLA-style normalized cross-correlation against the other tap (which is at
// full gain at that moment), so the two overlapping grains are phase-aligned and
// chords don't comb/warble.
//
// Latency is the average tap delay: the splice point found by the search (up to
// one low-string period, less for higher notes) plus half the window a grain
// traverses, which shrinks for cents-only shifts because long grains drift less. At 0 cents the shifter is a true
// bit-exact passthrough (zero latency); engaging/disengaging crossfades over
// ~20 ms. Pure C++ (no JUCE) so it can be unit-tested standalone.
//
// Threading: setShiftCents / setWindowMs from any thread (atomics);
// prepare/reset on the device thread while audio is stopped; process on the
// audio thread (RT-safe: no allocation, no locks).
class LivePitchShifter
{
public:
    static constexpr float kMaxShiftCents = 500.0f;   // +/- 5 semitones
    static constexpr float kMinWindowMs = 6.0f;
    static constexpr float kMaxWindowMs = 40.0f;
    static constexpr float kDefaultWindowMs = 14.0f;
    static constexpr float kEngageThresholdCents = 0.05f;

    void prepare(double sampleRate, int maxBlockSize);
    void reset();

    void setShiftCents(float cents);
    float getShiftCents() const { return targetCents.load(std::memory_order_relaxed); }
    void setWindowMs(float ms);
    float getWindowMs() const { return windowMs.load(std::memory_order_relaxed); }

    // True when a non-zero shift is requested.
    bool isEngaged() const
    {
        const float c = targetCents.load(std::memory_order_relaxed);
        return c > kEngageThresholdCents || c < -kEngageThresholdCents;
    }
    // True while any wet signal is being produced (engaged or fading out).
    // When false, process() leaves the buffer untouched.
    bool isActive() const { return active.load(std::memory_order_relaxed); }
    // Current pitch ratio actually applied (1.0 when bypassed).
    float getCurrentRatio() const { return reportedRatio.load(std::memory_order_relaxed); }
    // Average added delay of the wet path in samples (0 when bypassed).
    float getLatencySamples() const { return reportedLatency.load(std::memory_order_relaxed); }

    // In-place mono processing.
    void process(float* mono, int numSamples) noexcept;

private:
    struct Tap
    {
        double delay = 0.0;   // samples behind the write head
    };

    float readHermite(double delay) const noexcept;
    double chooseStartDelay(double otherDelay, double lo, double hi) const noexcept;
    void restartTap(Tap& tap, const Tap& other) noexcept;
    void updateGrainGeometry() noexcept;

    double sr = 48000.0;
    std::vector<float> line;     // circular delay line (power-of-two size)
    uint64_t mask = 0;
    uint64_t writeIndex = 0;     // absolute count of samples written

    std::atomic<float> targetCents{0.0f};
    std::atomic<float> windowMs{kDefaultWindowMs};
    std::atomic<bool> active{false};
    std::atomic<float> reportedRatio{1.0f};
    std::atomic<float> reportedLatency{0.0f};

    // Audio-thread state.
    double ratio = 1.0;          // smoothed pitch ratio
    double ratioCoeff = 0.0;     // one-pole smoothing coefficient per sample
    double mix = 0.0;            // dry(0) -> wet(1) crossfade position
    double mixStep = 0.0;        // per-sample crossfade increment
    double phase = 0.0;          // shared grain phasor in [0, 1)
    double grainLen = 1.0;       // samples per grain
    double windowSpan = 0.0;     // delay range one grain traverses (samples)
    double minDelay = 4.0;       // keeps the 4-point interpolator behind the write head
    double searchSpan = 0.0;     // WSOLA search span above the start delay (samples)
    double maxGrain = 1.0;       // cap so tiny shifts don't make second-long grains
    int corrLen = 256;           // correlation template length (samples)
    mutable std::vector<float> scores;   // WSOLA candidate scores, sized in prepare()
    Tap tapA, tapB;
    bool tapsPrimed = false;
};
