# Deferred Items

Problems noticed during refactor but deliberately not fixed now.

- (found in Phase 2, I-006) build-common.sh's repo->dirname fallback (strip `feedback-plugin-`, `-`→`_`) never runs: every plugin entry has an explicit `:dirname`, and the strip is case-sensitive while repos are `feedBack-plugin-*`. Remove or fix later.
- (found in Phase 2, I-004) 55 audio:* handlers throw instead of returning a fallback when the addon call throws. Guarding them is a behaviour change; decide explicitly, not as part of the callAddon refactor.
- (found in Phase 3, I-002) The python.ts <-> soundfont-manager.ts require cycle is still there: python.ts needs getActiveSoundfontPath and soundfont-manager needs restartPython. Moving the config out did not break it (the audit over-claimed). Harmless today (both uses are inside functions).
- (Phase 3, I-004) ~27 other guarded addon sites in audio-bridge.ts were NOT folded into callAddon(): they validate args between the guard and the call (guard order decides which fallback you get), catch silently, or have no try (the bare getters like getSongBusClock, getStreamSinkLevel). Each would be a small behaviour change; take them one at a time if wanted. setLivePitch/getLivePitch must stay self-contained (tests/engine/live-pitch.test.js extracts them verbatim).
- FIXED in 60218a7: (Phase 3, I-003 app check) MIDI PC mode: loading a song wipes the chain, so the VST the program changes target is gone (getChainState() == [] after load). Same on the pre-I-003 code (A/B on the packaged build), so pre-existing. Likely the 400 ms _aeClearChainForNewSong path not exempting MIDI mode.
- (Phase 3, I-003 app check) One song load rebuilds the chain up to three times (IIFE 2 preload + IIFE 1 song:ready reapplies at 600/1500 ms); a locked song logged "[tone-lock] whole song" 3-4 times. Now serialised, but redundant clear/load work (and VST editor windows closing) per song.
