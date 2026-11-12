// fanOutStereoMix ("Play on multiple outputs"): the stereo mix in channels 0/1
// is copied to every further pair (even = L, odd = R), muted channels are
// silenced, and a channel whose mute changed since the last block fades over
// that block instead of cutting (no click).

#include "../../src/audio/engine/OutputFanout.h"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace
{
constexpr int kSamples = 64;
constexpr float kL = 0.5f;
constexpr float kR = -0.25f;

struct Block
{
    std::vector<std::vector<float>> data;
    std::vector<float*> ptrs;

    explicit Block(int channels)
        : data((size_t) channels, std::vector<float>((size_t) kSamples, 9.0f)) // stale garbage
    {
        for (auto& c : data) ptrs.push_back(c.data());
        std::fill(data[0].begin(), data[0].end(), kL);
        if (channels > 1) std::fill(data[1].begin(), data[1].end(), kR);
    }
    float* const* out() { return ptrs.data(); }
    int channels() const { return (int) data.size(); }
};

bool near(float a, float b) { return std::fabs(a - b) < 1e-6f; }

void expectConstant(const Block& b, int ch, float v)
{
    for (float s : b.data[(size_t) ch]) assert(near(s, v));
}

// Linear fade from g0 to g1 applied to a constant source value.
void expectRamp(const Block& b, int ch, float src, float g0, float g1)
{
    const auto& c = b.data[(size_t) ch];
    for (int i = 0; i < kSamples; ++i)
    {
        const float g = g0 + (g1 - g0) * (float) (i + 1) / (float) kSamples;
        assert(std::fabs(c[(size_t) i] - src * g) < 1e-5f);
    }
    assert(near(c.back(), src * g1));
}
} // namespace

int main()
{
    using slopsmith::fanOutStereoMix;

    // Nothing muted: every pair carries the mix, stale data is overwritten.
    {
        Block b(6);
        uint64_t prev = 0;
        fanOutStereoMix(b.out(), b.channels(), kSamples, 0, prev);
        for (int ch = 0; ch < 6; ++ch) expectConstant(b, ch, (ch & 1) ? kR : kL);
        assert(prev == 0);
    }

    // Steady mute on pair 1 (channels 2/3) and on the source pair: silenced,
    // while pair 2 still gets the mix copied from the (pre-mute) source.
    {
        Block b(6);
        const uint64_t mask = 0b001111;
        uint64_t prev = mask;
        fanOutStereoMix(b.out(), b.channels(), kSamples, mask, prev);
        for (int ch = 0; ch < 4; ++ch) expectConstant(b, ch, 0.0f);
        expectConstant(b, 4, kL);
        expectConstant(b, 5, kR);
        assert(prev == mask);
    }

    // Muting pair 1 fades it out over the block; unmuting pair 2 fades it in.
    {
        Block b(6);
        uint64_t prev = 0b110000;          // pair 2 was muted
        const uint64_t mask = 0b001100;    // now pair 1 is muted instead
        fanOutStereoMix(b.out(), b.channels(), kSamples, mask, prev);
        expectConstant(b, 0, kL);
        expectConstant(b, 1, kR);
        expectRamp(b, 2, kL, 1.0f, 0.0f);
        expectRamp(b, 3, kR, 1.0f, 0.0f);
        expectRamp(b, 4, kL, 0.0f, 1.0f);
        expectRamp(b, 5, kR, 0.0f, 1.0f);
        assert(prev == mask);

        // Next block: the new state holds, no further ramp.
        Block n(6);
        fanOutStereoMix(n.out(), n.channels(), kSamples, mask, prev);
        expectConstant(n, 2, 0.0f);
        expectConstant(n, 3, 0.0f);
        expectConstant(n, 4, kL);
        expectConstant(n, 5, kR);
    }

    // Muting the source pair fades it in place, after the copies took the
    // full-level mix.
    {
        Block b(4);
        uint64_t prev = 0;
        fanOutStereoMix(b.out(), b.channels(), kSamples, 0b0011, prev);
        expectRamp(b, 0, kL, 1.0f, 0.0f);
        expectRamp(b, 1, kR, 1.0f, 0.0f);
        expectConstant(b, 2, kL);
        expectConstant(b, 3, kR);
    }

    // Odd channel count: the trailing channel is even, so it takes L.
    {
        Block b(3);
        uint64_t prev = 0;
        fanOutStereoMix(b.out(), b.channels(), kSamples, 0, prev);
        expectConstant(b, 2, kL);
    }

    // Mono device: nothing to fan out; a mute still silences channel 0.
    {
        Block b(1);
        uint64_t prev = 1;
        fanOutStereoMix(b.out(), b.channels(), kSamples, 1, prev);
        expectConstant(b, 0, 0.0f);
    }

    // Plain stereo, nothing muted: the mix passes through untouched.
    {
        Block b(2);
        uint64_t prev = 0;
        fanOutStereoMix(b.out(), b.channels(), kSamples, 0, prev);
        expectConstant(b, 0, kL);
        expectConstant(b, 1, kR);
    }

    // Channels >= 64 are never muted (the mask has 64 bits).
    {
        assert(! slopsmith::outputChannelMuted(~uint64_t{0}, 64));
        assert(slopsmith::outputChannelMuted(uint64_t{1} << 63, 63));
        assert(! slopsmith::outputChannelMuted(~uint64_t{0}, -1));
    }

    // Degenerate input is a no-op and leaves prev alone.
    {
        uint64_t prev = 7;
        fanOutStereoMix(nullptr, 4, kSamples, 0, prev);
        Block b(4);
        fanOutStereoMix(b.out(), b.channels(), 0, 0, prev);
        assert(prev == 7);
        expectConstant(b, 2, 9.0f);
    }

    std::puts("output_fanout: all cases passed");
    return 0;
}
