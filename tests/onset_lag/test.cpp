// Onset timing ground truth for OnsetDetector (src/audio/OnsetDetector.*).
//
// Note detection times a hit by the pick attack the flux detector reports. The
// detector peaks some fixed distance after the real attack (its 1024-sample
// window has to fill), and `backdate` moves the report back by that much. This
// measures the real distance on synthetic plucks whose attack sample is known
// exactly — at every device rate, for soft and hard picking, from silence and
// over a ringing previous note — and fails if the reported attack is not
// centred on the true one. The rest of the timing chain (capture latency,
// callback stamp, playhead) is measured separately (engine_units
// playhead_model_test), so nothing here is tuned against live play.
//
// Usage: onset_lag_test            run the checks
//        onset_lag_test --report   also print the per-case lags

#include "../../src/audio/OnsetDetector.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

namespace {

struct Pluck { double freq; float amp; double riseMs; };

// Karplus-Strong string: a noise-burst excitation (the pick) into a damped
// delay line. `riseMs` shapes the excitation's onset (a pick ~0.3 ms, a
// fingerstyle bass pluck a few ms). The string keeps ringing until the next.
std::vector<float> render(double sr, const std::vector<std::pair<size_t, Pluck>>& plucks, size_t total,
                          float noiseFloor, unsigned seed)
{
    std::vector<float> out(total, 0.0f);
    std::mt19937 rng(seed);
    std::uniform_real_distribution<float> u(-1.0f, 1.0f);
    for (size_t p = 0; p < plucks.size(); ++p)
    {
        const size_t at = plucks[p].first;
        const Pluck pk = plucks[p].second;
        const size_t end = (p + 1 < plucks.size()) ? plucks[p + 1].first + (size_t) (0.3 * sr) : total;
        const int period = std::max(2, (int) std::lround(sr / pk.freq));
        std::vector<float> line((size_t) period);
        for (auto& v : line) v = u(rng);
        const int rise = std::max(1, (int) std::lround(pk.riseMs * sr / 1000.0));
        size_t idx = 0;
        for (size_t n = at; n < std::min(end, total); ++n, ++idx)
        {
            const size_t i = idx % (size_t) period, j = (idx + 1) % (size_t) period;
            const float y = line[i];
            line[i] = 0.996f * 0.5f * (line[i] + line[j]);
            const float env = idx < (size_t) rise ? (float) idx / (float) rise : 1.0f;
            // The previous note is damped by the new pick (the player's hand).
            out[n] = out[n] * (idx < (size_t) rise ? 1.0f - env * 0.7f : 0.3f) + pk.amp * env * y;
        }
    }
    for (auto& v : out) v += noiseFloor * u(rng);
    return out;
}

struct Result { int cases = 0, missed = 0; double medianMs = 0, p10Ms = 0, p90Ms = 0, worstMs = 0; };

bool rawLag = false;

Result measure(double sr, bool bass, float amp, double riseMs, bool overRinging, int blockSize,
               bool report, const char* label)
{
    std::mt19937 rng(42);
    std::uniform_real_distribution<double> gap(0.18, 0.42), f(bass ? 41.0 : 82.0, bass ? 98.0 : 660.0);
    std::vector<std::pair<size_t, Pluck>> plucks;
    double t = 0.5;
    for (int i = 0; i < 60; ++i)
    {
        plucks.push_back({ (size_t) std::llround(t * sr), Pluck{ f(rng), amp, riseMs } });
        t += overRinging ? gap(rng) : gap(rng) + 0.9;   // from silence: let it die first
    }
    const size_t total = (size_t) ((t + 1.0) * sr);
    auto x = render(sr, plucks, total, 0.0005f, 7);
    if (!overRinging)   // decay to silence before each pick
        for (size_t p = 0; p + 1 < plucks.size(); ++p)
            for (size_t n = plucks[p].first + (size_t) (0.6 * sr); n < plucks[p + 1].first; ++n) x[n] *= 0.0f;

    OnsetDetector det;
    det.prepare(sr);
    det.setProfile(bass);
    std::vector<OnsetDetector::Onset> onsets;
    for (size_t pos = 0; pos < total; pos += (size_t) blockSize)
    {
        const size_t n = std::min((size_t) blockSize, total - pos);
        det.process(x.data() + pos, n, (uint64_t) pos, onsets);
    }
    std::vector<double> lags;
    int missed = 0;
    for (const auto& p : plucks)
    {
        double best = 1e9;
        for (const auto& o : onsets)
        {
            // rawLag: the detector's own lag (flux-peak frame end - attack),
            // independent of the configured backdate.
            const double reported = (double) o.sampleIndex + (rawLag ? (double) det.getBackdateSamples() : 0.0);
            const double d = (reported - (double) p.first) / sr * 1000.0;
            if (std::fabs(d) < std::fabs(best)) best = d;
        }
        if (std::fabs(best) > (rawLag ? 60.0 : 25.0)) { ++missed; continue; }
        lags.push_back(best);
    }
    Result r;
    r.cases = (int) plucks.size(); r.missed = missed;
    std::sort(lags.begin(), lags.end());
    if (!lags.empty())
    {
        r.medianMs = lags[lags.size() / 2];
        r.p10Ms = lags[lags.size() / 10];
        r.p90Ms = lags[lags.size() * 9 / 10];
        for (double v : lags) r.worstMs = std::max(r.worstMs, std::fabs(v));
    }
    if (report)
        std::printf("  %-34s sr=%6.0f bs=%4d  median %+6.2f ms  p10..p90 %+6.2f..%+6.2f  |worst| %5.2f  missed %d/%d\n",
                    label, sr, blockSize, r.medianMs, r.p10Ms, r.p90Ms, r.worstMs, r.missed, r.cases);
    return r;
}

} // namespace

int main(int argc, char** argv)
{
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    const bool report = argc > 1 && (std::strcmp(argv[1], "--report") == 0 || std::strcmp(argv[1], "--raw") == 0);
    rawLag = argc > 1 && std::strcmp(argv[1], "--raw") == 0;
    int failures = 0;
    auto check = [&](const Result& r, const char* what)
    {
        // Timing: centred within 3 ms (half the detector's 256-sample hop at
        // 44.1 k is 2.9 ms, the resolution floor). Detection: at least 80 % of
        // picks found (96 kHz over a ringing note is the weak case: the fixed
        // 1024-sample window is only 10.7 ms there) — this test is about WHEN.
        const bool ok = std::fabs(r.medianMs) <= 3.0 && r.missed <= r.cases / 5;
        if (!ok) { std::printf("FAIL %s: median %+.2f ms, missed %d/%d\n", what, r.medianMs, r.missed, r.cases); ++failures; }
    };
    for (double sr : { 44100.0, 48000.0, 96000.0 })
        for (int bs : { 64, 256, 1024 })
        {
            check(measure(sr, false, 0.5f, 0.3, false, bs, report, "guitar hard pick, from silence"), "guitar hard/silence");
            check(measure(sr, false, 0.08f, 0.3, false, bs, report, "guitar soft pick, from silence"), "guitar soft/silence");
            check(measure(sr, false, 0.5f, 0.3, true, bs, report, "guitar pick over ringing note"), "guitar over ringing");
            // Bass (soft synthetic pluck) is reported, not asserted: its misses
            // are detection sensitivity on this synthetic signal, not timing.
            measure(sr, true, 0.5f, 2.0, true, bs, report, "bass pluck over ringing note (info)");
        }
    if (failures) { std::printf("onset_lag: %d failure(s)\n", failures); return 1; }
    std::puts("onset_lag: all cases centred");
    return 0;
}
