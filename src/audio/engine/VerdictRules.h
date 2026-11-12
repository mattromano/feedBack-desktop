#pragma once
// VerdictRules: the NoteVerifier's per-note decisions that don't need audio,
// kept JUCE-free so tests/engine_units can test them directly.

#include <cmath>
#include <cstddef>
#include <limits>
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
inline bool palmMuteCountsOnAttack(bool pitchHit, bool palmMuted, bool legato)
{
    return ! pitchHit && palmMuted && ! legato;
}

// The nearest chart times before and after note `idx` that differ from its
// own (a chord's other strings share its time), or -inf / +inf when there is
// none. `notes` is any indexable sequence of { t }, in any order.
template <class Notes>
void neighbourTimes(const Notes& notes, std::size_t idx, double& prevT, double& nextT)
{
    const double t = notes[idx].t;
    prevT = -std::numeric_limits<double>::infinity();
    nextT = std::numeric_limits<double>::infinity();
    for (std::size_t k = 0; k < notes.size(); ++k)
    {
        const double tk = notes[k].t;
        if (tk < t && tk > prevT) prevT = tk;
        else if (tk > t && tk < nextT) nextT = tk;
    }
}

// The pick attack a palm-muted note the comb missed counts on, or -1:
//  - the attack a string of the same chord (same chart time) already claimed:
//    one strum is one onset, and every string it sounded shares it;
//  - else the nearest unclaimed attack within `tol` that is nearer this note
//    than the chart notes either side of it, so a note the player skipped
//    can't take its neighbour's attack in a riff faster than the tolerance.
// `log` is an indexable sequence of { songTime, claimed, claimedFor }.
template <class Log>
int palmMuteAttack(const Log& log, double t, double tol, double prevT, double nextT)
{
    int best = -1;
    double bestDist = tol;
    for (std::size_t k = 0; k < log.size(); ++k)
    {
        // Chord strings carry the chord's exact chart time, so == is safe.
        if (! log[k].claimed || log[k].claimedFor != t) continue;
        const double d = std::abs(log[k].songTime - t);
        if (d <= bestDist) { bestDist = d; best = (int) k; }
    }
    if (best >= 0) return best;

    bestDist = tol;
    for (std::size_t k = 0; k < log.size(); ++k)
    {
        if (log[k].claimed) continue;
        const double o = log[k].songTime;
        const double d = std::abs(o - t);
        if (! (d < std::abs(o - prevT)) || ! (d < std::abs(o - nextT))) continue;
        if (d <= bestDist) { bestDist = d; best = (int) k; }
    }
    return best;
}

// One finalized note, as the verifier's finalize pass sees it.
struct PassNote
{
    double t = 0.0;          // chart time (seconds)
    bool pitchHit = false;   // the comb confirmed its pitch in its window
    bool palmMuted = false;
    bool legato = false;     // hammer-on / pull-off: no pick attack
    // Neighbouring chart times (neighbourTimes). Only read for a palm-muted
    // note the comb missed.
    double prevT = -std::numeric_limits<double>::infinity();
    double nextT = std::numeric_limits<double>::infinity();
};

// Its verdict: hit or miss, and the onset-log index of the pick attack that
// times it (-1: reported on-time).
struct PassVerdict
{
    bool detected = false;
    int attack = -1;
};

// Decide every note finalized in one verifier pass and mark the pick attacks
// they claim in `log` (an indexable sequence of
// { songTime, claimed, claimedFor }).
//
// Notes the comb heard go first, in order, and claim exactly what they did
// before the palm-mute rule, so a note counted on its attack alone never
// takes a heard note's attack and non-palm-muted notes are unaffected. Then
// each palm-muted note the comb missed counts on palmMuteAttack.
template <class Log>
std::vector<PassVerdict> finalizePass(const std::vector<PassNote>& notes, Log& log, double tol)
{
    std::vector<PassVerdict> out(notes.size());
    for (std::size_t i = 0; i < notes.size(); ++i)
    {
        const PassNote& n = notes[i];
        if (! n.pitchHit) continue;
        out[i].detected = true;
        if (n.legato) continue;
        const int a = nearestUnclaimedOnset(log, n.t, tol);
        if (a < 0) continue;
        log[(std::size_t) a].claimed = true;
        log[(std::size_t) a].claimedFor = n.t;
        out[i].attack = a;
    }
    for (std::size_t i = 0; i < notes.size(); ++i)
    {
        const PassNote& n = notes[i];
        if (! palmMuteCountsOnAttack(n.pitchHit, n.palmMuted, n.legato)) continue;
        const int a = palmMuteAttack(log, n.t, tol, n.prevT, n.nextT);
        if (a < 0) continue;
        log[(std::size_t) a].claimed = true;
        log[(std::size_t) a].claimedFor = n.t;
        out[i].detected = true;
        out[i].attack = a;
    }
    return out;
}

} // namespace slopsmith
