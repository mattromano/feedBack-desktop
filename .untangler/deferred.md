# Deferred Items

Problems noticed during refactor but deliberately not fixed now.

- (found in Phase 2, I-006) build-common.sh's repo->dirname fallback (strip `feedback-plugin-`, `-`→`_`) never runs: every plugin entry has an explicit `:dirname`, and the strip is case-sensitive while repos are `feedBack-plugin-*`. Remove or fix later.
- (found in Phase 2, I-004) 55 audio:* handlers throw instead of returning a fallback when the addon call throws. Guarding them is a behaviour change; decide explicitly, not as part of the callAddon refactor.
