# Native Android Voice Design

**Date:** 2026-08-19
**Status:** Approved design checkpoint
**Scope:** Android dictation behavior, lifecycle safety, and optional backend transcript refinement

## Behavioral contract

The native app treats the React Native implementation as a behavior reference,
not an architecture to copy.

In a thread with an empty composer, pressing for less than 220 ms remains a tap.
Holding for 220 ms starts dictation. While held, an upward drag of at least 56 dp
locks capture when upward travel is the dominant axis. A sideways drag of at
least 72 dp cancels when sideways travel is dominant. Releasing an ordinary hold
stops capture and leaves the transcript in the composer for review; it does not
send automatically. A locked session survives release and the primary button
becomes an explicit stop-dictation action. New-session dictation remains a
tap-to-start, tap-to-stop control.

Partial recognition text appears immediately. Each final utterance is appended
to the session base so later partial results cannot erase earlier sentences.
Normal stop preserves the latest native transcript. Cancel stops capture and
restores the exact draft snapshot from before capture, correcting the current RN
defect where the cancel hint is shown but dictated text remains.

Permission denial is explicit. A requestable denial can be retried; a permanent
denial exposes an action that opens this application's details settings. Missing
recognition services, temporary service death, and audio-route changes are
runtime availability failures, not preferences, and never overwrite a saved
draft or setting.

## Architecture

The voice feature is split into a pure state machine, an orchestration
controller, and thin Android adapters.

`VoiceSessionReducer` owns gesture classification, the original draft snapshot,
partial/final composition, held versus locked state, cancellation, normal stop,
permission presentation, refinement state, and revision fencing. Inputs and
outputs carry a monotonically increasing session token. Events from an older
recognizer, recorder, timeout, or backend request are ignored after cancel,
restart, screen destruction, or a newer capture.

The controller depends on ports for speech recognition, optional refinement
audio capture, permissions/settings, clock/scheduling, and backend
transcription. It translates reducer effects into I/O and feeds typed results
back into the reducer. Android framework objects do not enter the domain layer.

The Android speech adapter probes `SpeechRecognizer.isRecognitionAvailable` on
each start, requests partial results in the device locale, maps framework errors
to typed failures, and invokes all recognizer methods on the main thread. Every
terminal path cancels or stops as appropriate, removes the listener, and calls
`destroy()` exactly once. Screen disposal and real application backgrounding
use the same idempotent shutdown path.

The permission adapter distinguishes granted, requestable denial, and permanent
denial. Its settings action uses `ACTION_APPLICATION_DETAILS_SETTINGS` with the
application package URI and safely handles the absence of a matching activity.

## Capture and refinement safety

Platform speech recognition is always authoritative. The first native milestone
does not run an unconditional `AudioRecord` in parallel with
`SpeechRecognizer`, because microphone contention can silence or destabilize
recognition even when a second capture appears to start successfully.

Refinement audio is capability-gated. The `RefinementAudioCapture` port reports
whether a safe shared source is available for the current recognizer and device.
Without that capability, dictation proceeds normally and refinement is skipped
without an error. This temporary capability result is never persisted as a user
preference. The adapter seam permits a future API 33+ shared PCM source only
after recognizer support is checked and verified on hardware. Recognition
buffers are not treated as a recording source because Android does not guarantee
that `RecognitionListener.onBufferReceived` is called.

When safe capture exists, it produces 16 kHz, mono, PCM16 WAV data and owns a
private cache file. Stop, cancel, timeout, backgrounding, screen destruction,
and capture failure all release native resources. Cancel deletes the file.
Normal completion deletes it after refinement settles or is skipped.

Refinement reuses the existing `stt:transcribe` request:

- raw base64 audio without a data URL prefix;
- `audio/wav` MIME type;
- current project/worktree path;
- measured duration;
- maximum duration of two minutes and decoded size of 25 MiB;
- a client-side timeout of 30 seconds.

A transport success is not automatically a domain success. The client parses
the body and accepts only `{ ok: true, text, provider: "whisper", modelId }`.
`{ ok: false, error }`, malformed success bodies, timeouts, disconnects, and
service loss retain the native transcript. Follow-up refinement failure never
turns successful dictation into a failed command.

## Draft ownership and revision fence

Starting capture stores the exact original draft and its revision. Native
partial/final updates are tagged as voice-owned changes for the active session.
Cancellation invalidates the session and restores the exact snapshot in one
draft mutation.

Normal stop records the final native draft and the revision after that mutation.
A corrected transcript may replace it only when all of the following remain
true:

1. the session token is still current;
2. capture was stopped normally rather than cancelled or destroyed;
3. the draft revision still equals the stop revision;
4. the current draft still equals the recorded native final;
5. the corrected text is nonblank and differs from the current text.

Any user edit, send, restore, or newer dictation advances the revision. That
makes stale refinement a no-op even when text happens to return to an earlier
value. Saved draft durability continues to belong to the existing composer
runtime; temporary voice state is never stored as a preference.

## Lifecycle and dynamic topology

The controller accepts explicit screen disposal and application-background
events. Both invalidate callbacks first, then stop/cancel the recognizer,
release optional capture, cancel pending timers, delete transient audio, and
publish a non-listening state. Repeated disposal is safe.

Configuration replacement must not be mistaken for a true app-background
transition. The UI owner still disposes its listener-bound controller during
screen destruction so no framework listener retains the old screen. A recreated
screen starts idle over the durable current draft; it never resumes a microphone
session implicitly.

Recognizer availability and optional capture capability are checked again on
the next start. A missing service or route can therefore recover while the app
remains alive.

## Test strategy

Implementation proceeds test-first once the shared Gradle gate reopens.

Pure JVM tests cover:

- the 220 ms hold boundary and 56/72 dp dominant-axis gesture rules;
- thread tap/hold/release, slide-up lock, explicit locked stop, and sideways
  cancel;
- new-session tap start/stop;
- partial display and multi-final accumulation;
- exact original-draft restoration;
- session-token rejection of late recognizer and backend events;
- revision-fenced refinement after edit, send, cancel, or a newer session;
- timeout, size/duration skip policy, malformed bodies, and 2xx domain failure;
- permission states and actionable settings presentation;
- background/screen-destroy cleanup and repeated-release idempotence;
- temporary recognizer/recorder loss followed by a successful retry.

Adapter tests cover intent construction, framework error mapping, main-thread
dispatch, and cleanup seams where the JVM can prove them. Instrumentation tests
cover permission round trips, configuration replacement, backgrounding, and
screen recreation. Physical-device testing remains required for microphone
latency, Bluetooth and route changes, recognizer/service death, partial-result
quality, and resource release. Automated tests alone are not evidence for those
hardware behaviors.

## References

- [SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer)
- [RecognitionListener](https://developer.android.com/reference/android/speech/RecognitionListener)
- [RecognizerIntent](https://developer.android.com/reference/android/speech/RecognizerIntent)
- [AudioRecord](https://developer.android.com/reference/android/media/AudioRecord)
- [Application details settings](https://developer.android.com/reference/android/provider/Settings#ACTION_APPLICATION_DETAILS_SETTINGS)
