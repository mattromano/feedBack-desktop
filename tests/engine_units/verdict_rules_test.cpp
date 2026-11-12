// VerdictRules (src/audio/engine/VerdictRules.h): which pick attack a note
// claims, and when a palm-muted note counts on its attack alone.
//
// A palm-muted chug is a damped thud the harmonic comb often can't hear: on a
// chugged C5 riff about 1 in 3 palm-muted chords scored 0/2 strings and were
// missed (2026-11-12). The rule lets such a note count when it was picked in
// its window, and only then.

#include "../../src/audio/engine/VerdictRules.h"

#include <cassert>
#include <cstdio>
#include <vector>
#ifdef _MSC_VER
#include <crtdbg.h>
#endif

using slopsmith::nearestUnclaimedOnset;
using slopsmith::palmMuteHitOnAttack;

struct Onset { double songTime; bool claimed; };

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

static void testPalmMuteHitOnAttack()
{
    // Palm-muted, comb heard nothing, picked in the window: counts.
    assert(palmMuteHitOnAttack(false, true, false, true));
    // No attack in the window: still a miss.
    assert(! palmMuteHitOnAttack(false, true, false, false));
    // Not palm-muted: a ringing note must still be heard.
    assert(! palmMuteHitOnAttack(false, false, false, true));
    // Legato has no attack to count on.
    assert(! palmMuteHitOnAttack(false, true, true, true));
    // Already a pitch hit: not an attack-only hit.
    assert(! palmMuteHitOnAttack(true, true, false, true));
}

static slopsmith::PassNote note(double t, bool heard, bool pm, bool legato = false)
{
    slopsmith::PassNote n;
    n.t = t;
    n.pitchHit = heard;
    n.palmMuted = pm;
    n.legato = legato;
    return n;
}

static void testFinalizePassSingleNotes()
{
    using slopsmith::finalizePass;
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

int main()
{
#ifdef _MSC_VER
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
#endif
    testNearestUnclaimedOnset();
    testPalmMuteHitOnAttack();
    testFinalizePassSingleNotes();
    std::printf("verdict_rules_test: all passed\n");
    return 0;
}
