#pragma once
// VerdictRules: the NoteVerifier's per-note decisions that don't need audio,
// kept JUCE-free so tests/engine_units can test them directly.

#include <cmath>
#include <cstddef>
#include <vector>

namespace slopsmith {

// Index of the unclaimed pick attack nearest chart time `t`, within `tol`
// seconds, or -1. `log` is any indexable sequence of { songTime, claimed }.
template <class Log>
int nearestUnclaimedOnset(const Log& log, double t, double tol)
{
    int best = -1;
    double bestDist = tol;
    for (std::size_t k = 0; k < log.size(); ++k)
    {
        if (log[k].claimed) continue;
        const double d = std::abs(log[k].songTime - t);
        if (d <= bestDist) { bestDist = d; best = (int) k; }
    }
    return best;
}

// A palm-muted note is a short damped thud with little pitch, so the harmonic
// comb often hears none of its strings even when it was played on time: on a
// chugged C5 riff about 1 in 3 palm-muted chords scored 0/2 strings (measured
// 2026-11-12). Such a note counts on its pick attack instead. Legato notes
// (hammer-on / pull-off) have no attack, so they never qualify.
inline bool palmMuteHitOnAttack(bool pitchHit, bool palmMuted, bool legato, bool attackInWindow)
{
    return ! pitchHit && palmMuted && ! legato && attackInWindow;
}

// One finalized note, as the verifier's finalize pass sees it.
struct PassNote
{
    double t = 0.0;          // chart time (seconds)
    bool pitchHit = false;   // the comb confirmed its pitch in its window
    bool palmMuted = false;
    bool legato = false;     // hammer-on / pull-off: no pick attack
};

// Its verdict: hit or miss, and the onset-log index of the pick attack that
// times it (-1: reported on-time).
struct PassVerdict
{
    bool detected = false;
    int attack = -1;
};

// Decide every note finalized in one verifier pass, in order, and mark the
// pick attacks they claim in `log` (an indexable sequence of
// { songTime, claimed }).
template <class Log>
std::vector<PassVerdict> finalizePass(const std::vector<PassNote>& notes, Log& log, double tol)
{
    std::vector<PassVerdict> out(notes.size());
    for (std::size_t i = 0; i < notes.size(); ++i)
    {
        const PassNote& n = notes[i];
        const int attack = n.legato ? -1 : nearestUnclaimedOnset(log, n.t, tol);
        const bool onAttack = palmMuteHitOnAttack(n.pitchHit, n.palmMuted, n.legato, attack >= 0);
        if (! (n.pitchHit || onAttack)) continue;
        out[i].detected = true;
        if (attack >= 0)
        {
            log[(std::size_t) attack].claimed = true;
            out[i].attack = attack;
        }
    }
    return out;
}

} // namespace slopsmith
