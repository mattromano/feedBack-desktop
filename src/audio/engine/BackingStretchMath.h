#pragma once

// Pure decision + latency math for the backing-track stretcher (speed and
// pitch). JUCE-free so tests/engine_units can pin the bypass boundaries, the
// pitch sanitizer, and the playhead latency compensation without a device.
// BackingPlayer is the only production caller.

#include <cmath>

namespace slopsmith::backing {

// |rate - 1| below this uses the direct transport path (no phase vocoder).
inline constexpr double kSpeedBypassEpsilon = 1.0e-4;

// Transpose range, in semitones. An octave each way covers every practical
// "play along detuned" case (a guitar tuned down a whole step, a song charted
// in Eb played in E standard, a capo'd recording, …) while keeping the phase
// vocoder in the range where it still sounds musical.
inline constexpr double kMaxPitchSemitones = 12.0;

// Pitch requests are quantized to whole cents; |semitones| below half a cent
// rounds to 0 and leaves the stretcher bypassed (bit-transparent path at 1×).
inline constexpr double kPitchStepSemitones = 0.01;

// Sanitize a requested transpose: reject non-finite input (returns false and
// leaves `out` untouched), otherwise clamp to ±kMaxPitchSemitones and round
// to the nearest cent. -0 normalizes to +0 so the getter never reports "-0".
inline bool sanitizePitchSemitones(double semitones, double& out) noexcept
{
    if (!std::isfinite(semitones)) return false;
    double clamped = semitones;
    if (clamped >  kMaxPitchSemitones) clamped =  kMaxPitchSemitones;
    if (clamped < -kMaxPitchSemitones) clamped = -kMaxPitchSemitones;
    const double cents = std::round(clamped / kPitchStepSemitones);
    out = (cents == 0.0) ? 0.0 : cents * kPitchStepSemitones;
    return true;
}

// True when a (sanitized) transpose is audible, i.e. the stretcher must run
// even at 1× speed.
inline bool pitchActive(double semitones) noexcept
{
    return std::abs(semitones) >= kPitchStepSemitones * 0.5;
}

// The stretcher path is needed when the speed is off 1× OR a transpose is set.
// Otherwise the transport is read directly (zero added latency).
inline bool stretchEngaged(double rate, double semitones) noexcept
{
    return std::abs(rate - 1.0) >= kSpeedBypassEpsilon || pitchActive(semitones);
}

// How far (in SOURCE seconds) the audible output trails the source frames
// already pulled into the stretcher, so the published playhead can be pulled
// back and the chart stays aligned with what is heard.
//
// Per signalsmith-stretch's latency model the processing time sits
// inputLatency() source samples behind the newest input, and the output is a
// further outputLatency() output samples behind the processing time — i.e.
// outputLatency() * rate source samples (this is the library's own
// outputSeekLength(rate)). Zero when the stretcher is bypassed.
inline double stretchLatencySourceSeconds(bool engaged, int inputLatencySamples,
                                          int outputLatencySamples, double rate,
                                          double sampleRate) noexcept
{
    if (!engaged || !(sampleRate > 0.0)) return 0.0;
    const double frames = static_cast<double>(inputLatencySamples)
                        + static_cast<double>(outputLatencySamples) * rate;
    return frames > 0.0 ? frames / sampleRate : 0.0;
}

} // namespace slopsmith::backing
