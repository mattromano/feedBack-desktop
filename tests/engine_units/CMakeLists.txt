# engine_units — home for the per-unit tests of the audio-engine decomposition
# (docs/audio-engine-tlc.md Part IV §4/0.c). JUCE-free targets only: units are
# extracted so they can be tested against a state struct + fake ring, without a
# real device. One executable per unit keeps failures attributable.
add_executable(gain_sanitize_test gain_sanitize_test.cpp)
target_compile_features(gain_sanitize_test PRIVATE cxx_std_17)
add_test(NAME gain_sanitize COMMAND gain_sanitize_test)

# PackedStereoRing uses std::bit_cast (C++20) and std::thread.
add_executable(packed_stereo_ring_test packed_stereo_ring_test.cpp)
target_compile_features(packed_stereo_ring_test PRIVATE cxx_std_20)
find_package(Threads REQUIRED)
target_link_libraries(packed_stereo_ring_test PRIVATE Threads::Threads)
add_test(NAME packed_stereo_ring COMMAND packed_stereo_ring_test)

add_executable(engine_state_test engine_state_test.cpp)
target_compile_features(engine_state_test PRIVATE cxx_std_17)
add_test(NAME engine_state COMMAND engine_state_test)

add_executable(renderer_bus_test renderer_bus_test.cpp)
target_compile_features(renderer_bus_test PRIVATE cxx_std_20)
add_test(NAME renderer_bus COMMAND renderer_bus_test)

add_executable(rate_match_test rate_match_test.cpp)
target_compile_features(rate_match_test PRIVATE cxx_std_17)
add_test(NAME rate_match COMMAND rate_match_test)

add_executable(ring_residency_trim_test ring_residency_trim_test.cpp)
target_compile_features(ring_residency_trim_test PRIVATE cxx_std_17)
add_test(NAME ring_residency_trim COMMAND ring_residency_trim_test)

add_executable(playhead_model_test playhead_model_test.cpp)
target_compile_features(playhead_model_test PRIVATE cxx_std_17)
add_test(NAME playhead_model COMMAND playhead_model_test)

add_executable(output_fanout_test output_fanout_test.cpp)
target_compile_features(output_fanout_test PRIVATE cxx_std_17)
add_test(NAME output_fanout COMMAND output_fanout_test)

add_executable(verdict_rules_test verdict_rules_test.cpp)
target_compile_features(verdict_rules_test PRIVATE cxx_std_17)
add_test(NAME verdict_rules COMMAND verdict_rules_test)
