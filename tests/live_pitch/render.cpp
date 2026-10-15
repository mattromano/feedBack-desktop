// Offline listening render for LivePitchShifter. Usage:
//   live_pitch_render <out_dir> [input.wav]
// Without an input WAV it synthesizes a plucked-string guitar clip (open E chord
// strum, power-chord chugs, single-note riff). Writes the dry clip plus shifted
// versions at -1, -2 and -5 semitones and +37 cents for each latency mode, so the
// shifter can be judged by ear before it goes into the app.
#include "../../src/audio/LivePitchShifter.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <vector>

namespace
{
constexpr int kSr = 48000;

struct Pluck
{
    double hz;
    double start;
    float amp;
};

std::vector<float> synthGuitar()
{
    // Karplus-Strong strings; E standard open chord, E5 chugs, then a riff.
    const double E2 = 82.41, B2 = 123.47, E3 = 164.81, Gs3 = 207.65, B3 = 246.94, E4 = 329.63;
    std::vector<Pluck> plucks;
    const double strum[] = { E2, B2, E3, Gs3, B3, E4 };
    for (int i = 0; i < 6; ++i) plucks.push_back({ strum[i], 0.10 + 0.012 * i, 0.35f });
    for (int k = 0; k < 8; ++k)
        for (double f : { E2, B2, E3 }) plucks.push_back({ f, 2.2 + 0.25 * k, 0.4f });
    const double riff[] = { E3, 196.0, 220.0, 246.94, 293.66, 246.94, 220.0, 196.0 };
    for (int k = 0; k < 8; ++k) plucks.push_back({ riff[k], 4.4 + 0.2 * k, 0.45f });

    std::vector<float> out((size_t) (kSr * 6.5), 0.0f);
    std::mt19937 rng(3);
    std::uniform_real_distribution<float> noise(-1.0f, 1.0f);
    for (const auto& p : plucks)
    {
        const int len = (int) std::lround(kSr / p.hz);
        std::vector<float> ring((size_t) len);
        for (auto& s : ring) s = noise(rng) * p.amp;
        const size_t start = (size_t) (p.start * kSr);
        // Chugs are palm-muted: shorter decay.
        const bool muted = p.start >= 2.2 && p.start < 4.4;
        const float decay = muted ? 0.985f : 0.9985f;
        size_t idx = 0;
        for (size_t i = start; i < out.size(); ++i)
        {
            const size_t a = idx % (size_t) len, b = (idx + 1) % (size_t) len;
            const float v = decay * 0.5f * (ring[a] + ring[b]);
            ring[a] = v;
            out[i] += v;
            ++idx;
            if (muted && i - start > (size_t) (0.22 * kSr)) break;
        }
    }
    return out;
}

bool readWav(const char* path, std::vector<float>& out)
{
    FILE* f = std::fopen(path, "rb");
    if (! f) return false;
    std::vector<uint8_t> d;
    uint8_t buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) d.insert(d.end(), buf, buf + n);
    std::fclose(f);
    if (d.size() < 44 || std::memcmp(d.data(), "RIFF", 4) != 0) return false;
    int channels = 1, bits = 16, fmt = 1;
    size_t pos = 12;
    while (pos + 8 <= d.size())
    {
        const uint32_t sz = d[pos + 4] | (d[pos + 5] << 8) | (d[pos + 6] << 16) | ((uint32_t) d[pos + 7] << 24);
        if (std::memcmp(&d[pos], "fmt ", 4) == 0)
        {
            fmt = d[pos + 8] | (d[pos + 9] << 8);
            channels = d[pos + 10] | (d[pos + 11] << 8);
            bits = d[pos + 22] | (d[pos + 23] << 8);
        }
        else if (std::memcmp(&d[pos], "data", 4) == 0)
        {
            const int bps = bits / 8;
            const size_t frames = sz / (size_t) (bps * channels);
            for (size_t i = 0; i < frames; ++i)
            {
                const uint8_t* s = &d[pos + 8 + i * (size_t) bps * channels];
                float v = 0.0f;
                if (fmt == 3 && bits == 32) std::memcpy(&v, s, 4);
                else if (bits == 16) v = (int16_t) (s[0] | (s[1] << 8)) / 32768.0f;
                else if (bits == 24) v = (float) ((int32_t) ((s[0] << 8) | (s[1] << 16) | ((uint32_t) s[2] << 24)) >> 8) / 8388608.0f;
                out.push_back(v);
            }
            return true;
        }
        pos += 8 + sz + (sz & 1);
    }
    return false;
}

void writeWav(const std::string& path, const std::vector<float>& v)
{
    FILE* f = std::fopen(path.c_str(), "wb");
    if (! f) return;
    auto u32 = [f](uint32_t x) { std::fwrite(&x, 4, 1, f); };
    auto u16 = [f](uint16_t x) { std::fwrite(&x, 2, 1, f); };
    const uint32_t bytes = (uint32_t) v.size() * 2;
    std::fwrite("RIFF", 1, 4, f); u32(36 + bytes); std::fwrite("WAVEfmt ", 1, 8, f);
    u32(16); u16(1); u16(1); u32(kSr); u32(kSr * 2); u16(2); u16(16);
    std::fwrite("data", 1, 4, f); u32(bytes);
    for (float s : v)
    {
        const float c = s > 1.0f ? 1.0f : (s < -1.0f ? -1.0f : s);
        u16((uint16_t) (int16_t) std::lround(c * 32767.0f));
    }
    std::fclose(f);
}
} // namespace

int main(int argc, char** argv)
{
    if (argc < 2)
    {
        std::printf("usage: live_pitch_render <out_dir> [input.wav (48 kHz)]\n");
        return 1;
    }
    const std::string dir = argv[1];
    std::vector<float> dry;
    if (argc >= 3 && ! readWav(argv[2], dry))
    {
        std::printf("could not read %s\n", argv[2]);
        return 1;
    }
    if (dry.empty()) dry = synthGuitar();
    writeWav(dir + "/00_dry.wav", dry);

    struct Mode { const char* name; float ms; } modes[] = { { "tight", 8.0f }, { "balanced", 14.0f }, { "smooth", 22.0f } };
    struct Shift { const char* name; float cents; } shifts[] = {
        { "down1st", -100.0f }, { "down2st", -200.0f }, { "down5st", -500.0f }, { "up37c", 37.0f } };
    for (const auto& s : shifts)
        for (const auto& m : modes)
        {
            LivePitchShifter ps;
            ps.prepare(kSr, 480);
            ps.setWindowMs(m.ms);
            ps.setShiftCents(s.cents);
            auto out = dry;
            double lat = 0.0;
            int blocks = 0;
            for (size_t p = 0; p < out.size(); p += 480)
            {
                const int n = (int) std::min<size_t>(480, out.size() - p);
                ps.process(out.data() + p, n);
                lat += ps.getLatencySamples();
                ++blocks;
            }
            const std::string name = std::string(s.name) + "_" + m.name + ".wav";
            writeWav(dir + "/" + name, out);
            std::printf("%-22s mean added latency %.1f ms\n", name.c_str(), lat / blocks * 1000.0 / kSr);
        }
    return 0;
}
