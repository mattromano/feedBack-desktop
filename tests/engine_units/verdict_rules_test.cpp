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

int main()
{
#ifdef _MSC_VER
    _CrtSetReportMode(_CRT_ASSERT, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(_CRT_ASSERT, _CRTDBG_FILE_STDERR);
#endif
    testNearestUnclaimedOnset();
    testPalmMuteHitOnAttack();
    std::printf("verdict_rules_test: all passed\n");
    return 0;
}
