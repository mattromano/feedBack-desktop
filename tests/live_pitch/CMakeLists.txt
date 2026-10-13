# Pure, JUCE-free unit test for the live-guitar pitch shifter
# (src/audio/LivePitchShifter.*): pitch accuracy, bit-exact bypass, latency.
add_executable(live_pitch_test test.cpp ../../src/audio/LivePitchShifter.cpp)
target_compile_features(live_pitch_test PRIVATE cxx_std_17)
add_test(NAME live_pitch COMMAND live_pitch_test)
