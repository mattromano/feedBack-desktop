// VerdictRules (src/audio/engine/VerdictRules.h): which pick attack a note
// claims, and when a palm-muted note counts on its attack alone.
//
// A palm-muted chug is a damped thud the harmonic comb often can't hear: on a
// chugged C5 riff about 1 in 3 palm-muted chords scored 0/2 strings and were
// missed (2026-11-12). The rule lets such a note count when it was picked in
// its window, and only then.

#include "../../src/audio/engine/VerdictRules.h"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>
#ifdef _MSC_VER
#include <crtdbg.h>
#endif

using slopsmith::nearestUnclaimedOnset;
using slopsmith::finalizePass;
using slopsmith::neighbourTimes;
using slopsmith::palmMuteCountsOnAttack;
using slopsmith::PassNote;

struct Onset { double songTime = 0.0; bool claimed = false; double claimedFor = 0.0; };
struct ChartNote { double t; };

static void testNearestUnclaimedOnset()
{
    std::vector<Onset> log { { 0.90, false }, { 1.02, false }, { 1.12, false } };
    assert(nearestUnclaimedOnset(log, 1.0, 0.15) == 1);       // nearest
    log[1].claimed = true;
    assert(nearestUnclaimedOnset(log, 1.0, 0.15) == 0);       // claimed one skipped
    assert(nearestUnclaimedOnset(log, 1.0, 0.05) == -1);      // none inside tolerance
    std::vector<Onset> empty;
    assert(nearestUnclaimedOnset(empty, 1.0, 0.15) == -1);
}

static void testPalmMuteCountsOnAttack()
{
    // Palm-muted and the comb heard nothing: counts on its attack.
    assert(palmMuteCountsOnAttack(false, true, false));
    // Not palm-muted: a ringing note must still be heard.
    assert(! palmMuteCountsOnAttack(false, false, false));
    // Legato has no attack to count on.
    assert(! palmMuteCountsOnAttack(false, true, true));
    // Already a pitch hit: not an attack-only hit.
    assert(! palmMuteCountsOnAttack(true, true, false));
}

static void testNeighbourTimes()
{
    // A chord at 1.0 (two strings), notes either side, in no particular order.
    std::vector<ChartNote> chart { { 1.2 }, { 1.0 }, { 0.8 }, { 1.0 }, { 0.5 } };
    double prevT = 0.0, nextT = 0.0;
    neighbourTimes(chart, 1, prevT, nextT);
    assert(prevT == 0.8 && nextT == 1.2);             // skips its chord sibling
    neighbourTimes(chart, 4, prevT, nextT);
    assert(std::isinf(prevT) && prevT < 0 && nextT == 0.8);
    neighbourTimes(chart, 0, prevT, nextT);
    assert(prevT == 1.0 && std::isinf(nextT) && nextT > 0);
}

static PassNote note(double t, bool heard, bool pm, bool legato = false,
                     double prevT = -INFINITY, double nextT = INFINITY)
{
    PassNote n;
    n.prevT = prevT;
    n.nextT = nextT;
    n.t = t;
    n.pitchHit = heard;
    n.palmMuted = pm;
    n.legato = legato;
    return n;
}

static void testFinalizePassSingleNotes()
{
    // A heard picked note claims its attack and is timed by it.
    {
        std::vector<Onset> log { { 1.01, false } };
        const auto v = finalizePass({ note(1.0, true, false) }, log, 0.1);
        assert(v[0].detected && v[0].attack == 0 && log[0].claimed);
    }
    // A heard legato note has no attack: on-time, nothing claimed.
    {
        std::vector<Onset> log { { 1.01, false } };
        const auto v = finalizePass({ note(1.0, true, false, true) }, log, 0.1);
        assert(v[0].detected && v[0].attack == -1 && ! log[0].claimed);
    }
    // An unheard ringing note is a miss and leaves the attack for others.
    {
        std::vector<Onset> log { { 1.01, false } };
        const auto v = finalizePass({ note(1.0, false, false) }, log, 0.1);
        assert(! v[0].detected && v[0].attack == -1 && ! log[0].claimed);
    }
    // An unheard palm-muted note counts on its attack, and claims it.
    {
        std::vector<Onset> log { { 1.01, false } };
        const auto v = finalizePass({ note(1.0, false, true) }, log, 0.1);
        assert(v[0].detected && v[0].attack == 0 && log[0].claimed);
    }
    // ...but not with no attack in its window.
    {
        std::vector<Onset> log { { 1.5, false } };
        const auto v = finalizePass({ note(1.0, false, true) }, log, 0.1);
        assert(! v[0].detected && ! log[0].claimed);
    }
}

// A strummed chord makes one pick attack; every string it sounded shares it.
static void testPalmMutedChords()
{
    // Palm-muted C5, comb heard neither string: both count on the one strum.
    {
        std::vector<Onset> log { { 1.01 } };
        const auto v = finalizePass({ note(1.0, false, true), note(1.0, false, true) }, log, 0.1);
        assert(v[0].detected && v[1].detected);
        assert(v[0].attack == 0 && v[1].attack == 0);
    }
    // Three-string palm-muted power chord, nothing heard: 3/3, not 1/3.
    {
        std::vector<Onset> log { { 0.98 } };
        const auto v = finalizePass(
            { note(1.0, false, true), note(1.0, false, true), note(1.0, false, true) }, log, 0.1);
        assert(v[0].detected && v[1].detected && v[2].detected);
    }
    // One string heard, the other not, in either order: both count, and the
    // heard string keeps the attack it always claimed.
    for (int heardFirst = 0; heardFirst < 2; ++heardFirst)
    {
        std::vector<Onset> log { { 1.02 } };
        const bool h = heardFirst != 0;
        const auto v = finalizePass({ note(1.0, h, true), note(1.0, ! h, true) }, log, 0.1);
        assert(v[0].detected && v[1].detected);
        assert(v[0].attack == 0 && v[1].attack == 0);
        assert(log[0].claimed && log[0].claimedFor == 1.0);
    }
    // The strum's strings finalize in separate passes (different sustains):
    // the later one still shares the attack the earlier one claimed.
    {
        std::vector<Onset> log { { 1.01 } };
        const auto a = finalizePass({ note(1.0, false, true) }, log, 0.1);
        const auto b = finalizePass({ note(1.0, false, true) }, log, 0.1);
        assert(a[0].detected && b[0].detected && b[0].attack == 0);
    }
    // An attack claimed by a note at another time is not shared.
    {
        std::vector<Onset> log { { 1.01, true, 0.95 } };
        const auto v = finalizePass({ note(1.0, false, true) }, log, 0.1);
        assert(! v[0].detected);
    }
    // Non-palm-muted chord strings the comb missed still miss.
    {
        std::vector<Onset> log { { 1.01 } };
        const auto v = finalizePass({ note(1.0, true, false), note(1.0, false, false) }, log, 0.1);
        assert(v[0].detected && ! v[1].detected);
    }
}

// Chugs faster than the timing tolerance: a skipped note must not take a
// neighbour's attack.
static void testPalmMutedChugs()
{
    // 16ths at 160 bpm: 0.094 s apart, tolerance 0.1. The note at 1.0 was
    // skipped and the next (1.094) picked. The skipped note finalizes first
    // and sees that attack within tolerance, but it is nearer the next note.
    {
        const double t0 = 1.0, t1 = 1.094;
        std::vector<Onset> log { { t1 + 0.003 } };
        const auto v0 = finalizePass({ note(t0, false, true, false, 0.906, t1) }, log, 0.1);
        assert(! v0[0].detected && ! log[0].claimed);
        const auto v1 = finalizePass({ note(t1, false, true, false, t0, 1.188) }, log, 0.1);
        assert(v1[0].detected && v1[0].attack == 0);
    }
    // The previous note's late attack (left unclaimed because that note was
    // missed) is nearer the previous note: it doesn't credit this one.
    {
        const double tPrev = 0.906, t0 = 1.0;
        std::vector<Onset> log { { tPrev + 0.04 } };
        const auto v = finalizePass({ note(t0, false, true, false, tPrev, 1.094) }, log, 0.1);
        assert(! v[0].detected && ! log[0].claimed);
    }
    // Played a little late but still nearer its own note: counts.
    {
        std::vector<Onset> log { { 1.04 } };
        const auto v = finalizePass({ note(1.0, false, true, false, 0.906, 1.094) }, log, 0.1);
        assert(v[0].detected && v[0].attack == 0);
    }
    // A heard (comb-confirmed) note keeps the old rule: the nearest unclaimed
    // attack within tolerance, neighbours or not.
    {
        std::vector<Onset> log { { 1.06 } };
        const auto v = finalizePass({ note(1.0, true, false, false, 0.906, 1.094) }, log, 0.1);
        assert(v[0].detected && v[0].attack == 0);
    }
}

int main()
{
#ifdef _MSC_VER
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
#endif
    testNearestUnclaimedOnset();
    testPalmMuteCountsOnAttack();
    testNeighbourTimes();
    testFinalizePassSingleNotes();
    testPalmMutedChords();
    testPalmMutedChugs();
    std::printf("verdict_rules_test: all passed\n");
    return 0;
}
