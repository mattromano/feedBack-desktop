#include "LivePitchShifter.h"

#include <algorithm>
#include <cmath>

namespace
{
constexpr double kPi = 3.14159265358979323846;
constexpr double kRatioSmoothSeconds = 0.03;
constexpr double kMixFadeSeconds = 0.02;
constexpr double kMaxGrainSeconds = 0.2;
constexpr double kCorrSeconds = 0.005;
// WSOLA search span. It must cover at least one period of the lowest string
// (~14 ms reaches ~71 Hz, below drop-D) or splices leave a same-signed phase step
// that biases low notes sharp/flat; the earliest strong match is preferred so
// higher notes still splice close to the minimum delay.
constexpr double kMinSearchSeconds = 0.014;
constexpr double kSearchWindowFraction = 0.5;
constexpr double kGoodMatchFraction = 0.95;

uint64_t nextPow2(uint64_t v)
{
    uint64_t p = 1;
    while (p < v) p <<= 1;
    return p;
}
} // namespace

void LivePitchShifter::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr = sampleRate > 0.0 ? sampleRate : 48000.0;

    corrLen = std::clamp((int) std::lround(sr * kCorrSeconds), 32, 1024);
    maxGrain = sr * kMaxGrainSeconds;
    ratioCoeff = 1.0 - std::exp(-1.0 / (kRatioSmoothSeconds * sr));
    mixStep = 1.0 / (kMixFadeSeconds * sr);

    // Longest possible start delay: window + 2*search + guard, plus the
    // correlation template reaching further back.
    const double maxWindow = sr * kMaxWindowMs / 1000.0;
    const double maxSearch = std::max(sr * kMinSearchSeconds, maxWindow * kSearchWindowFraction);
    const double need = minDelay + maxWindow + maxSearch + corrLen + 64.0;
    const uint64_t size = nextPow2((uint64_t) std::ceil(need));
    line.assign((size_t) size, 0.0f);
    mask = size - 1;
    scores.assign((size_t) std::ceil(maxSearch) + 2, 0.0f);

    reset();
}

void LivePitchShifter::reset()
{
    std::fill(line.begin(), line.end(), 0.0f);
    writeIndex = 0;
    ratio = 1.0;
    mix = 0.0;
    phase = 0.0;
    tapA = {};
    tapB = {};
    tapsPrimed = false;
    active.store(false, std::memory_order_relaxed);
    reportedRatio.store(1.0f, std::memory_order_relaxed);
    reportedLatency.store(0.0f, std::memory_order_relaxed);
}

void LivePitchShifter::setShiftCents(float cents)
{
    if (! std::isfinite(cents)) cents = 0.0f;
    targetCents.store(std::clamp(cents, -kMaxShiftCents, kMaxShiftCents), std::memory_order_relaxed);
}

void LivePitchShifter::setWindowMs(float ms)
{
    if (! std::isfinite(ms)) ms = kDefaultWindowMs;
    windowMs.store(std::clamp(ms, kMinWindowMs, kMaxWindowMs), std::memory_order_relaxed);
}

float LivePitchShifter::readHermite(double delay) const noexcept
{
    const double pos = (double) writeIndex - 1.0 - delay;
    const double fl = std::floor(pos);
    const float t = (float) (pos - fl);
    const int64_t i = (int64_t) fl;
    const float ym1 = line[(size_t) ((uint64_t) (i - 1) & mask)];
    const float y0  = line[(size_t) ((uint64_t) i & mask)];
    const float y1  = line[(size_t) ((uint64_t) (i + 1) & mask)];
    const float y2  = line[(size_t) ((uint64_t) (i + 2) & mask)];
    const float c1 = 0.5f * (y1 - ym1);
    const float c2 = ym1 - 2.5f * y0 + 2.0f * y1 - 0.5f * y2;
    const float c3 = 0.5f * (y2 - ym1) + 1.5f * (y0 - y1);
    return ((c3 * t + c2) * t + c1) * t + y0;
}

void LivePitchShifter::updateGrainGeometry() noexcept
{
    const double window = sr * (double) windowMs.load(std::memory_order_relaxed) / 1000.0;
    searchSpan = std::max(sr * kMinSearchSeconds, window * kSearchWindowFraction);
    const double drift = std::abs(1.0 - ratio);
    grainLen = drift > 1.0e-9 ? std::min(window / drift, maxGrain) : maxGrain;
    grainLen = std::max(grainLen, 2.0 * (double) corrLen);
    windowSpan = drift * grainLen;
}

double LivePitchShifter::chooseStartDelay(double otherDelay, double lo, double hi) const noexcept
{
    const int64_t w = (int64_t) writeIndex - 1;
    const int64_t ref = (int64_t) std::lround(otherDelay);
    const int step = std::max(1, (int) std::lround(sr / 48000.0));
    const int jStep = 2 * step;

    double refEnergy = 0.0;
    for (int j = 0; j < corrLen; j += jStep)
    {
        const float r = line[(size_t) ((uint64_t) (w - ref - j) & mask)];
        refEnergy += (double) r * r;
    }
    if (refEnergy < 1.0e-12)
        return 0.5 * (lo + hi);

    const int64_t dLo = (int64_t) std::ceil(lo);
    const int64_t dHi = std::min((int64_t) std::floor(hi), dLo + (int64_t) (scores.size() - 1) * step);
    const int count = (int) ((dHi - dLo) / step) + 1;
    double bestScore = -1.0e30;
    for (int k = 0; k < count; ++k)
    {
        const int64_t d = dLo + (int64_t) k * step;
        double dot = 0.0, energy = 0.0;
        for (int j = 0; j < corrLen; j += jStep)
        {
            const float c = line[(size_t) ((uint64_t) (w - d - j) & mask)];
            const float r = line[(size_t) ((uint64_t) (w - ref - j) & mask)];
            dot += (double) c * r;
            energy += (double) c * c;
        }
        const double score = dot / std::sqrt((energy + 1.0e-12) * refEnergy);
        scores[(size_t) k] = (float) score;
        bestScore = std::max(bestScore, score);
    }
    // Earliest interior local peak that is nearly as good as the best one:
    // phase-continuous like the global best, but with the least added delay. An
    // edge sample is not a peak (its true maximum lies outside the range), so it
    // is only used when the range holds no interior peak at all.
    int pick = -1;
    if (bestScore > 0.0)
    {
        const float good = (float) (bestScore * kGoodMatchFraction);
        for (int k = 1; k + 1 < count; ++k)
        {
            const float sc = scores[(size_t) k];
            if (sc >= good && sc >= scores[(size_t) k - 1] && sc >= scores[(size_t) k + 1])
            {
                pick = k;
                break;
            }
        }
    }
    double offset = 0.0;
    if (pick < 0)
    {
        pick = 0;
        for (int k = 1; k < count; ++k)
            if (scores[(size_t) k] > scores[(size_t) pick]) pick = k;
    }
    else
    {
        // Parabolic refinement to a sub-sample lag.
        const double ym = scores[(size_t) pick - 1], y0 = scores[(size_t) pick], yp = scores[(size_t) pick + 1];
        const double den = ym - 2.0 * y0 + yp;
        if (den < 0.0)
            offset = std::clamp(0.5 * (ym - yp) / den, -0.5, 0.5) * step;
    }
    const double best = (double) (dLo + (int64_t) pick * step) + offset;

    // Keep the other tap's fractional offset so the tested integer lag is exact.
    const double frac = otherDelay - (double) ref;
    return std::clamp(best + frac, lo, hi);
}

void LivePitchShifter::restartTap(Tap& tap, const Tap& other) noexcept
{
    // Ratio < 1 (down): delay grows over the grain, so start near the minimum.
    // Ratio > 1 (up): delay shrinks, so start a full window above the minimum.
    const double lo = ratio <= 1.0 ? minDelay : minDelay + windowSpan;
    const double hi = lo + searchSpan;
    tap.delay = chooseStartDelay(other.delay, lo, hi);
}

void LivePitchShifter::process(float* mono, int numSamples) noexcept
{
    if (mono == nullptr || numSamples <= 0 || line.empty())
        return;

    const float cents = targetCents.load(std::memory_order_relaxed);
    const bool engaged = cents > kEngageThresholdCents || cents < -kEngageThresholdCents;

    if (! engaged && mix <= 0.0)
    {
        // Bypassed: keep the delay line warm for a click-free re-engage, but
        // leave the signal bit-untouched.
        for (int i = 0; i < numSamples; ++i)
            line[(size_t) (writeIndex++ & mask)] = mono[i];
        ratio = 1.0;
        tapsPrimed = false;
        active.store(false, std::memory_order_relaxed);
        reportedRatio.store(1.0f, std::memory_order_relaxed);
        reportedLatency.store(0.0f, std::memory_order_relaxed);
        return;
    }

    active.store(true, std::memory_order_relaxed);
    const double targetRatio = engaged ? std::pow(2.0, (double) cents / 1200.0) : ratio;

    updateGrainGeometry();
    if (! tapsPrimed)
    {
        phase = 0.0;
        tapB.delay = minDelay + 0.5 * searchSpan;
        restartTap(tapA, tapB);
        tapsPrimed = true;
    }

    const double maxDelay = (double) line.size() - (double) corrLen - 8.0;
    const double mixTarget = engaged ? 1.0 : 0.0;

    for (int i = 0; i < numSamples; ++i)
    {
        const float x = mono[i];
        line[(size_t) (writeIndex++ & mask)] = x;

        ratio += (targetRatio - ratio) * ratioCoeff;
        const double drift = 1.0 - ratio;
        tapA.delay = std::clamp(tapA.delay + drift, minDelay, maxDelay);
        tapB.delay = std::clamp(tapB.delay + drift, minDelay, maxDelay);

        const double prev = phase;
        phase += 1.0 / grainLen;
        if (phase >= 1.0)
        {
            phase -= 1.0;
            restartTap(tapA, tapB);
        }
        else if (prev < 0.5 && phase >= 0.5)
        {
            restartTap(tapB, tapA);
        }

        const double s = std::sin(kPi * phase);
        const float gA = (float) (s * s);
        const float wet = gA * readHermite(tapA.delay) + (1.0f - gA) * readHermite(tapB.delay);

        if (mix < mixTarget) mix = std::min(mixTarget, mix + mixStep);
        else if (mix > mixTarget) mix = std::max(mixTarget, mix - mixStep);

        mono[i] = mix >= 1.0 ? wet : x + (wet - x) * (float) mix;
    }

    if (! engaged && mix <= 0.0)
    {
        ratio = 1.0;
        tapsPrimed = false;
        active.store(false, std::memory_order_relaxed);
        reportedRatio.store(1.0f, std::memory_order_relaxed);
        reportedLatency.store(0.0f, std::memory_order_relaxed);
        return;
    }

    reportedRatio.store((float) ratio, std::memory_order_relaxed);
    reportedLatency.store((float) (0.5 * (tapA.delay + tapB.delay) * mix), std::memory_order_relaxed);
}
