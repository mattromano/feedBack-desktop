# Onset timing ground truth: the real OnsetDetector on synthetic plucks with a
# known attack sample (see test.cpp). Needs juce_dsp for the FFT.
add_executable(onset_lag_test test.cpp ../../src/audio/OnsetDetector.cpp)
target_compile_features(onset_lag_test PRIVATE cxx_std_17)
target_link_libraries(onset_lag_test PRIVATE juce::juce_core juce::juce_dsp juce::juce_audio_basics juce::juce_audio_formats)
target_compile_definitions(onset_lag_test PRIVATE
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_STANDALONE_APPLICATION=1
    JUCE_DISABLE_ASSERTIONS=1 JUCE_LOG_ASSERTIONS=0 JUCE_MODAL_LOOPS_PERMITTED=0)
add_test(NAME onset_lag COMMAND onset_lag_test)
