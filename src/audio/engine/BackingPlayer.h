#pragma once

// BackingPlayer — the backing-track transport (TLC plan phase 3 / §2.4).
// Moved verbatim from AudioEngine: JUCE AudioFormatReaderSource →
// AudioTransportSource buffered by a TimeSliceThread read-ahead → optional
// signalsmith-stretch phase vocoder for speed change and pitch transpose
// (bypassed at 1× with no transpose), the
// per-song BackingLeveler loudness normalizer, and the playhead caches.
//
// Boundary: control-thread lifecycle (load/start/stop/seek/setSpeed/setPitch) and
// non-blocking cached getters live here; the RT mix POLICY (try-lock, RMS
// metering, volume fader, stream-submix capture) stays in the engine's
// output callbacks, which use the primitives getLock() / readyLocked() /
// renderBlockLocked() / renderBuffer() exactly as they open-coded them
// before. Both callbacks hold the try-lock through their stream publish so
// renderBuffer() is never read while prepare() can resize it.

#include "BackingStretchMath.h"
#include "EngineState.h"
#include "../BackingLeveler.h"
#include "signalsmith-stretch.h" // resolved via SS_STRETCH_DIR include path

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
#include <memory>

namespace slopsmith {

class BackingPlayer
{
public:
    static constexpr double kMaxSpeed = 4.0;
    // |rate - 1| below this uses the direct transport path (no phase vocoder)
    // unless a pitch transpose is set (see backing::stretchEngaged).
    static constexpr double kSpeedBypassEpsilon = backing::kSpeedBypassEpsilon;

    explicit BackingPlayer(EngineState& engineState) : state(engineState)
    {
        formatManager.registerBasicFormats();
        readThread.startThread();
    }

    // ── Control thread ────────────────────────────────────────────────────
    bool load(const juce::File& file);
    void setPosition(double seconds);
    void start();
    void stop();
    void setSpeed(double speed);
    // Transpose the backing track by `semitones` (clamped to
    // ±backing::kMaxPitchSemitones, rounded to whole cents) without changing
    // its tempo — e.g. -1.0 to play along on a guitar tuned down a half step.
    // Non-finite input is ignored. 0 disengages the stretcher (at 1× speed).
    // Lock-free like setSpeed; persists across seeks and song loads.
    void setPitch(double semitones);

    // Non-blocking reads — do not acquire the lock, never block the audio
    // callback.
    bool isPlaying() const { return playing.load(); }
    double getPosition() const { return cachedPosition.load(); }
    double getDuration() const { return cachedDuration.load(); }
    // Last requested (sanitized) transpose — what setPitch was last given,
    // even if the audio thread has not adopted it yet.
    double getPitch() const { return pendingPitch.load(std::memory_order_relaxed); }
    // Stretcher latency compensation in ms (source time) for the requested
    // speed/pitch: how far getPosition() is held behind the frames already
    // read from the file so the reported playhead matches what is heard.
    // 0 on the bypass path (1×, no transpose) or before a device is running.
    double getLatencyMs() const;

    // Re-prepare the transport + stretcher + buffers at a (new) device format.
    // Call from the about-to-start hook that owns backing playback (duplex:
    // input manager; split: output manager). No-op when nothing is loaded.
    void prepare(double sr, int bs);

    // ── RT primitives (output callbacks) ──────────────────────────────────
    // Usage pattern (unchanged from the open-coded version):
    //   const juce::ScopedTryLock sl(backing.getLock());
    //   if (sl.isLocked() && backing.readyLocked()) {
    //       const int n = backing.renderBlockLocked(numSamples);
    //       ... mix backing.renderBuffer() with the fader, meter RMS ...
    //   }
    juce::CriticalSection& getLock() { return lock; }
    bool readyLocked() const { return transport != nullptr && playing.load(); }
    // Renders one block (bypass or phase-vocoder stretch) into the render
    // buffer, advances heard/cached playheads, runs the loudness leveler, and
    // clears `playing` at EOF. Returns output frames written
    // (== jmin(numSamples, render-buffer cap)). Precondition: caller holds
    // the lock and has verified readyLocked().
    int renderBlockLocked(int numSamples);
    const juce::AudioBuffer<float>& renderBuffer() const { return outputBuffer; }

private:
    void stopNoLock();

    EngineState& state;

    juce::AudioFormatManager formatManager;

    // Read-ahead worker that fills the transport's buffer off the audio thread
    // (see load()). Declared BEFORE transport so it is destroyed AFTER it —
    // the transport's BufferingAudioSource holds a pointer to this thread and
    // must be torn down before the thread goes away.
    juce::TimeSliceThread readThread { "BackingReadAhead" };
    std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
    std::unique_ptr<juce::AudioTransportSource> transport;
    signalsmith::stretch::SignalsmithStretch<float> stretch;
    juce::AudioBuffer<float> inputBuffer;  // pulled from transport at device rate
    juce::AudioBuffer<float> outputBuffer; // stretch output, mixed by the callbacks
    // signalsmith latency halves (see backing::stretchLatencySourceSeconds),
    // captured whenever the stretcher is (re)configured.
    std::atomic<int> stretchInputLatencySamples{0};
    std::atomic<int> stretchLatencySamples{0};
    std::atomic<bool> playing{false};
    std::atomic<double> cachedPosition{0.0};
    std::atomic<double> cachedDuration{0.0};
    // Heard playhead: accumulates the source frames consumed each block, then
    // clamped to transport->getCurrentPosition() so a short read at EOF can't
    // push it past the real source point. cachedPosition is this value minus
    // the stretcher latency (zero on the bypass path).
    std::atomic<double> heardPositionSec{0.0};
    // Active playback rate. Mutated ONLY by the audio thread (in
    // renderBlockLocked), coupled with the stretcher reset, so a block is
    // never processed at a new rate with stale stretch state.
    std::atomic<double> speed{1.0};
    // Lock-free speed hand-off: setSpeed (control thread) publishes the
    // requested rate here and raises speedChangePending; the audio thread
    // adopts it on the next block. Avoids the control thread blocking on the
    // lock and starving the RT tryLock (which would drop a backing block
    // mid-slider-drag).
    std::atomic<double> pendingSpeed{1.0};
    std::atomic<bool> speedChangePending{false};
    // Pitch transpose in semitones — same lock-free hand-off as speed:
    // setPitch publishes pendingPitch + raises pitchChangePending; the audio
    // thread adopts it into `pitch` and the stretcher's transpose.
    std::atomic<double> pitch{0.0};
    std::atomic<double> pendingPitch{0.0};
    std::atomic<bool> pitchChangePending{false};
    // Per-song loudness normalizer (applied in renderBlockLocked, pre-fader).
    // Owned + driven by the audio thread.
    BackingLeveler leveler;
    double levelerSr = 0.0;
    juce::CriticalSection lock;
};

} // namespace slopsmith
