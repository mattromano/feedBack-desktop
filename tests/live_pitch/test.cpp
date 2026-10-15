// Standalone tests for LivePitchShifter (src/audio/LivePitchShifter.*): pitch
// accuracy, bit-exact bypass, bounded output, latency, block-size independence
// and engage/disengage. No JUCE; plain asserts with a non-zero exit on failure.
#include "../../src/audio/LivePitchShifter.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>

namespace
{
constexpr double kSr = 48000.0;
constexpr double kPi = 3.14159265358979323846;
int failures = 0;

void check(bool ok, const char* what)
{
    if (! ok)
    {
        std::printf("FAIL: %s\n", what);
        ++failures;
    }
}

std::vector<float> sine(double hz, double seconds, float amp = 0.5f)
{
    std::vector<float> v((size_t) (seconds * kSr));
    for (size_t i = 0; i < v.size(); ++i)
        v[i] = amp * (float) std::sin(2.0 * kPi * hz * (double) i / kSr);
    return v;
}

struct RunResult
{
    std::vector<float> out;
    double meanLatency = 0.0;
};

RunResult run(const std::vector<float>& in, float cents, float windowMs, int block)
{
    LivePitchShifter ps;
    ps.prepare(kSr, block);
    ps.setWindowMs(windowMs);
    ps.setShiftCents(cents);
    RunResult r;
    r.out = in;
    double latSum = 0.0;
    int latCount = 0;
    for (size_t pos = 0; pos < r.out.size(); pos += (size_t) block)
    {
        const int n = (int) std::min<size_t>((size_t) block, r.out.size() - pos);
        ps.process(r.out.data() + pos, n);
        if (pos > (size_t) (0.3 * kSr))
        {
            latSum += ps.getLatencySamples();
            ++latCount;
        }
    }
    r.meanLatency = latCount > 0 ? latSum / latCount : 0.0;
    return r;
}

// Frequency from interpolated rising zero crossings over [from, end).
double measureHz(const std::vector<float>& v, size_t from)
{
    double first = -1.0, last = -1.0;
    int count = 0;
    for (size_t i = from + 1; i < v.size(); ++i)
    {
        if (v[i - 1] < 0.0f && v[i] >= 0.0f)
        {
            const double t = (double) (i - 1) + v[i - 1] / (double) (v[i - 1] - v[i]);
            if (first < 0.0) first = t;
            else ++count;
            last = t;
        }
    }
    if (count < 2) return -1.0;
    return kSr * count / (last - first);
}

double rmsDbRipple(const std::vector<float>& v, size_t from, size_t win)
{
    double lo = 1e30, hi = 0.0;
    for (size_t s = from; s + win <= v.size(); s += win)
    {
        double e = 0.0;
        for (size_t i = s; i < s + win; ++i) e += (double) v[i] * v[i];
        const double rms = std::sqrt(e / win);
        lo = std::min(lo, rms);
        hi = std::max(hi, rms);
    }
    return 20.0 * std::log10(hi / std::max(lo, 1e-12));
}
} // namespace

int main()
{
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    // 1. Bypass at 0 cents is bit-exact.
    {
        std::mt19937 rng(7);
        std::uniform_real_distribution<float> dist(-1.0f, 1.0f);
        std::vector<float> in((size_t) kSr);
        for (auto& s : in) s = dist(rng);
        const auto r = run(in, 0.0f, 14.0f, 480);
        check(r.out == in, "0 cents is bit-exact passthrough");
        check(r.meanLatency == 0.0, "0 cents reports zero latency");
    }

    // 2. Pitch accuracy across shifts, frequencies, windows and block sizes.
    const float shifts[] = { -500.0f, -200.0f, -100.0f, -12.0f, 37.0f, 100.0f, 500.0f };
    const double freqs[] = { 82.41, 110.0, 440.0 };
    const int blocks[] = { 32, 128, 480, 1024 };
    double worstCents = 0.0;
    for (float c : shifts)
        for (double f : freqs)
            for (int b : blocks)
            {
                const auto in = sine(f, 2.0);
                const auto r = run(in, c, 14.0f, b);
                const double got = measureHz(r.out, (size_t) (0.5 * kSr));
                const double want = f * std::pow(2.0, c / 1200.0);
                const double err = 1200.0 * std::log2(got / want);
                worstCents = std::max(worstCents, std::abs(err));
                if (! (std::abs(err) <= 3.0))
                {
                    std::printf("  %.2f Hz %+.0f c block %d: got %.3f want %.3f (%+.2f c)\n",
                                f, c, b, got, want, err);
                    check(false, "pitch within 3 cents");
                }
                bool finite = true;
                float peak = 0.0f;
                for (float s : r.out)
                {
                    finite = finite && std::isfinite(s);
                    peak = std::max(peak, std::abs(s));
                }
                check(finite, "output finite");
                check(peak <= 0.6f, "output bounded (0.5 amp in)");
            }
    std::printf("pitch: worst error %.3f cents\n", worstCents);

    // 3. Latency per window (reported mean added delay) and level stability.
    const float windows[] = { 10.0f, 14.0f, 22.0f };
    const float latencyShifts[] = { -20.0f, -100.0f, -200.0f, -500.0f, 500.0f };
    for (float w : windows)
        for (float c : latencyShifts)
        {
            // Two-note "chord" so overlapping grains can comb if misaligned.
            auto in = sine(110.0, 2.0, 0.3f);
            const auto in2 = sine(164.8, 2.0, 0.25f);
            for (size_t i = 0; i < in.size(); ++i) in[i] += in2[i];
            const auto r = run(in, c, w, 480);
            const double ms = r.meanLatency * 1000.0 / kSr;
            const double ripple = rmsDbRipple(r.out, (size_t) (0.5 * kSr), (size_t) (0.05 * kSr));
            std::printf("window %4.0f ms  shift %+5.0f c: latency %5.2f ms  level ripple %4.2f dB\n",
                        w, c, ms, ripple);
            check(ms > 0.0 && ms <= w + 14.0, "latency within window bound");
            check(ripple < 3.0, "level ripple under 3 dB");
        }

    // 4. Disengage returns to bit-exact passthrough after the fade.
    {
        LivePitchShifter ps;
        ps.prepare(kSr, 256);
        ps.setShiftCents(-100.0f);
        auto buf = sine(220.0, 0.5);
        for (size_t p = 0; p < buf.size(); p += 256)
            ps.process(buf.data() + p, (int) std::min<size_t>(256, buf.size() - p));
        check(ps.isActive(), "engaged after -100 c");
        ps.setShiftCents(0.0f);
        std::vector<float> tail = sine(220.0, 0.1);
        for (size_t p = 0; p + 256 <= tail.size(); p += 256) ps.process(tail.data() + p, 256);
        check(! ps.isActive(), "inactive after fade-out");
        const auto clean = sine(220.0, 0.1);
        auto again = clean;
        for (size_t p = 0; p + 256 <= again.size(); p += 256) ps.process(again.data() + p, 256);
        check(again == clean, "bit-exact after disengage");
    }

    // 5. Parameter clamps.
    {
        LivePitchShifter ps;
        ps.setShiftCents(-9999.0f);
        check(ps.getShiftCents() == -LivePitchShifter::kMaxShiftCents, "cents clamp");
        ps.setShiftCents(std::nanf(""));
        check(ps.getShiftCents() == 0.0f, "NaN cents -> 0");
        ps.setWindowMs(1000.0f);
        check(ps.getWindowMs() == LivePitchShifter::kMaxWindowMs, "window clamp");
    }

    if (failures == 0) std::printf("live_pitch: all tests passed\n");
    return failures == 0 ? 0 : 1;
}
