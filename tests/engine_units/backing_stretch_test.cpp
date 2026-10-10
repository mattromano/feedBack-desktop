// Backing-track stretcher units: the pitch sanitizer, the bypass decision, and
// the playhead latency compensation in engine/BackingStretchMath.h — plus an
// end-to-end check against the real signalsmith-stretch (header-only, JUCE-
// free) that a transpose actually moves the pitch at 1× and that the latency
// model the playhead compensation uses matches where audio really comes out.

#include "../../src/audio/engine/BackingStretchMath.h"
#include "signalsmith-stretch.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <vector>

using namespace slopsmith::backing;

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

bool near(double a, double b, double tol) { return std::abs(a - b) <= tol; }

constexpr double kPi = 3.14159265358979323846;
constexpr float kSr = 48000.0f;
constexpr int kBlock = 512;

// Streams `in` (mono, duplicated to stereo) through a default-preset stretcher
// block by block at `rate` (source frames per output frame), exactly as
// BackingPlayer::renderBlockLocked pulls ceil(out * rate) frames per block.
std::vector<float> runStretch(const std::vector<float>& in, double rate,
                              double semitones, int& inLat, int& outLat)
{
    signalsmith::stretch::SignalsmithStretch<float> stretch;
    stretch.presetDefault(2, kSr);
    stretch.reset();
    stretch.setTransposeSemitones((float) semitones);
    inLat = stretch.inputLatency();
    outLat = stretch.outputLatency();

    std::vector<float> out;
    std::vector<float> inL(kBlock * 8), inR(kBlock * 8), outL(kBlock), outR(kBlock);
    size_t readPos = 0;
    double owed = 0.0; // fractional source frames carried between blocks
    while (readPos < in.size())
    {
        owed += kBlock * rate;
        const int n = (int) owed;
        owed -= n;
        for (int i = 0; i < n; ++i)
        {
            const float v = (readPos + i < in.size()) ? in[readPos + i] : 0.0f;
            inL[i] = inR[i] = v;
        }
        readPos += n;
        float* inPtrs[2] = { inL.data(), inR.data() };
        float* outPtrs[2] = { outL.data(), outR.data() };
        stretch.process(inPtrs, n, outPtrs, kBlock);
        out.insert(out.end(), outL.begin(), outL.end());
    }
    return out;
}

// Dominant frequency of `x[start, start+len)` via a fine DFT scan around
// `guess` (±25%) — enough to tell a semitone apart (~6%).
double dominantHz(const std::vector<float>& x, size_t start, size_t len, double guess)
{
    double bestHz = 0.0, bestMag = -1.0;
    for (double hz = guess * 0.75; hz <= guess * 1.25; hz += 0.5)
    {
        double re = 0.0, im = 0.0;
        for (size_t i = 0; i < len; ++i)
        {
            const double ph = 2.0 * kPi * hz * (double) i / kSr;
            re += x[start + i] * std::cos(ph);
            im -= x[start + i] * std::sin(ph);
        }
        const double mag = re * re + im * im;
        if (mag > bestMag) { bestMag = mag; bestHz = hz; }
    }
    return bestHz;
}

// Output index of the first sample whose magnitude crosses half the peak.
size_t firstOnset(const std::vector<float>& x)
{
    float peak = 0.0f;
    for (float v : x) peak = std::max(peak, std::abs(v));
    for (size_t i = 0; i < x.size(); ++i)
        if (std::abs(x[i]) >= 0.5f * peak) return i;
    return x.size();
}

} // namespace

int main()
{
    // ── sanitizePitchSemitones ─────────────────────────────────────────────
    double s = 99.0;
    CHECK(!sanitizePitchSemitones(std::numeric_limits<double>::quiet_NaN(), s));
    CHECK(!sanitizePitchSemitones(std::numeric_limits<double>::infinity(), s));
    CHECK(!sanitizePitchSemitones(-std::numeric_limits<double>::infinity(), s));
    CHECK(s == 99.0); // rejected input leaves the output untouched

    CHECK(sanitizePitchSemitones(0.0, s) && s == 0.0);
    CHECK(sanitizePitchSemitones(-1.0, s) && s == -1.0);
    CHECK(sanitizePitchSemitones(-0.5, s) && near(s, -0.5, 1e-12));
    // Cent precision: 17 cents down survives, sub-cent noise rounds away.
    CHECK(sanitizePitchSemitones(-0.17, s) && near(s, -0.17, 1e-12));
    CHECK(sanitizePitchSemitones(-0.1749, s) && near(s, -0.17, 1e-12));
    CHECK(sanitizePitchSemitones(0.004, s) && s == 0.0);
    CHECK(sanitizePitchSemitones(-0.004, s) && s == 0.0 && !std::signbit(s));
    // Clamp to ±kMaxPitchSemitones.
    CHECK(sanitizePitchSemitones(30.0, s) && s == kMaxPitchSemitones);
    CHECK(sanitizePitchSemitones(-30.0, s) && s == -kMaxPitchSemitones);

    // ── stretchEngaged: speed OR pitch engages, neither bypasses ───────────
    CHECK(!stretchEngaged(1.0, 0.0));
    CHECK(!stretchEngaged(1.0 + kSpeedBypassEpsilon * 0.5, 0.0));
    CHECK(stretchEngaged(0.5, 0.0));
    CHECK(stretchEngaged(1.0, -1.0));   // pitch alone engages at 1×
    CHECK(stretchEngaged(1.0, 0.01));   // one cent is audible intent
    CHECK(!stretchEngaged(1.0, 0.004)); // sub-cent is not
    CHECK(stretchEngaged(0.75, 2.0));

    // ── stretchLatencySourceSeconds ────────────────────────────────────────
    CHECK(stretchLatencySourceSeconds(false, 2880, 2880, 1.0, 48000.0) == 0.0);
    CHECK(stretchLatencySourceSeconds(true, 2880, 2880, 1.0, 0.0) == 0.0);
    CHECK(near(stretchLatencySourceSeconds(true, 2880, 2880, 1.0, 48000.0), 0.12, 1e-12));
    // Output half is in output samples → scaled by the rate into source time.
    CHECK(near(stretchLatencySourceSeconds(true, 2880, 2880, 0.5, 48000.0), 0.09, 1e-12));
    CHECK(near(stretchLatencySourceSeconds(true, 2880, 2880, 2.0, 48000.0), 0.18, 1e-12));

    // ── Real stretcher: transpose at 1× moves the pitch, keeps the tempo ───
    {
        const double inHz = 220.0;
        std::vector<float> sine((size_t) kSr * 2);
        for (size_t i = 0; i < sine.size(); ++i)
            sine[i] = 0.5f * (float) std::sin(2.0 * kPi * inHz * (double) i / kSr);

        int inLat = 0, outLat = 0;
        const auto down = runStretch(sine, 1.0, -2.0, inLat, outLat);
        CHECK(down.size() >= sine.size()); // 1:1 pull: same length out
        const double expect = inHz * std::pow(2.0, -2.0 / 12.0); // ~196 Hz
        const double got = dominantHz(down, (size_t) kSr / 2, 8192, expect);
        std::printf("  transpose -2 st: %.1f Hz (expected %.1f)\n", got, expect);
        CHECK(near(got, expect, 3.0));

        const auto cents = runStretch(sine, 1.0, -0.5, inLat, outLat);
        const double expectC = inHz * std::pow(2.0, -0.5 / 12.0); // ~213.7 Hz
        const double gotC = dominantHz(cents, (size_t) kSr / 2, 16384, expectC);
        std::printf("  transpose -50 c: %.1f Hz (expected %.1f)\n", gotC, expectC);
        CHECK(near(gotC, expectC, 2.0));
    }

    // ── Real stretcher: latency model matches where an onset comes out ─────
    // A tone burst that starts at source frame N must be heard at output
    // frame o where o * rate - (inLat + outLat * rate) == N, i.e. exactly the
    // stretchLatencySourceSeconds() the playhead subtracts. (Compensating the
    // output half alone would leave the chart ~inputLatency ahead.)
    for (double rate : { 1.0, 0.5 })
    {
        const size_t onsetAt = (size_t) kSr; // 1.0 s
        std::vector<float> burst((size_t) kSr * 3, 0.0f);
        for (size_t i = onsetAt; i < burst.size(); ++i)
            burst[i] = 0.5f * (float) std::sin(2.0 * kPi * 330.0 * (double) (i - onsetAt) / kSr);

        int inLat = 0, outLat = 0;
        const auto out = runStretch(burst, rate, -1.0, inLat, outLat);
        const double heardSourceSec = (double) firstOnset(out) * rate / kSr;
        const double reported = heardSourceSec
            - stretchLatencySourceSeconds(true, inLat, outLat, rate, kSr);
        const double errMs = (reported - (double) onsetAt / kSr) * 1000.0;
        std::printf("  rate %.2f: inLat=%d outLat=%d onset error %.1f ms\n",
                    rate, inLat, outLat, errMs);
        // Measured error is ~1 ms; leaving out the input half (the previous
        // compensation) would be off by inputLatency = 60 ms at 48 kHz.
        CHECK(std::abs(errMs) < 10.0);
    }

    if (g_failed > 0)
    {
        std::fprintf(stderr, "backing_stretch_test: %d check(s) failed\n", g_failed);
        return 1;
    }
    std::printf("backing_stretch_test: all checks passed\n");
    return 0;
}
