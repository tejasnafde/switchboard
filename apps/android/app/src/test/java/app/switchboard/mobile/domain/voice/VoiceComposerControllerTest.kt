package app.switchboard.mobile.domain.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceComposerControllerTest {
    @Test
    fun `permanent permission denial exposes settings without starting recognition`() {
        val fixture = fixture(permission = VoicePermissionDecision.Denied(canAskAgain = false))

        fixture.controller.start()

        assertEquals("Microphone permission needed.", fixture.controller.state.notice?.message)
        assertEquals(VoiceNoticeAction.OpenSettings, fixture.controller.state.notice?.action)
        assertEquals(0, fixture.recognizer.startCalls)
        fixture.controller.openNoticeAction()
        assertEquals(1, fixture.permission.openSettingsCalls)
    }

    @Test
    fun `recognizer availability is probed again after temporary service loss`() {
        val fixture = fixture()
        fixture.recognizer.available = false

        fixture.controller.start()
        assertEquals("Voice recognition is unavailable.", fixture.controller.state.notice?.message)
        assertFalse(fixture.controller.state.available)

        fixture.recognizer.available = true
        fixture.controller.start()
        assertTrue(fixture.controller.state.available)
        assertTrue(fixture.controller.state.session.listening)
        assertEquals(1, fixture.recognizer.startCalls)
    }

    @Test
    fun `cancel restores exact original draft and releases the active session once`() {
        val published = mutableListOf<String>()
        val fixture = fixture(initialDraft = "  exact original  ", onDraft = published::add)
        fixture.controller.start()
        fixture.recognizer.listener!!.onPartial("temporary")

        fixture.controller.cancel()
        fixture.recognizer.listener!!.onFinal("late")

        assertEquals("  exact original  ", fixture.controller.state.session.draft.text)
        assertEquals("  exact original  ", published.last())
        assertEquals(1, fixture.recognizer.session.cancelCalls)
        assertEquals(1, fixture.recognizer.session.closeCalls)
    }

    @Test
    fun `normal stop keeps native transcript and absent safe capture skips refinement`() {
        val fixture = fixture(initialDraft = "base")
        fixture.controller.start()
        fixture.recognizer.listener!!.onFinal("native")

        fixture.controller.stop()
        fixture.recognizer.listener!!.onEnd()

        assertEquals("base native", fixture.controller.state.session.draft.text)
        assertEquals(VoiceCapturePhase.Idle, fixture.controller.state.session.phase)
        assertEquals(1, fixture.recognizer.session.stopCalls)
        assertEquals(1, fixture.recognizer.session.closeCalls)
        assertEquals(0, fixture.refiner.requests.size)
    }

    @Test
    fun `recognizer ending an utterance while still held restarts without losing accumulated text`() {
        val fixture = fixture(initialDraft = "base")
        fixture.controller.start()
        fixture.recognizer.listener!!.onFinal("first sentence")

        fixture.recognizer.listener!!.onEnd()

        assertEquals(2, fixture.recognizer.startCalls)
        assertTrue(fixture.controller.state.session.listening)
        assertEquals("base first sentence", fixture.controller.state.session.draft.text)
        assertEquals(1, fixture.recognizer.sessions.first().closeCalls)
    }

    @Test
    fun `editing while bounded refinement is pending defeats the stale callback`() {
        val fixture = fixture(
            initialDraft = "base",
            audio = VoiceCapturedAudio(ByteArray(160), "audio/wav", durationMs = 1_000),
        )
        fixture.controller.start()
        fixture.recognizer.listener!!.onFinal("native")
        fixture.controller.stop()
        fixture.recognizer.listener!!.onEnd()
        assertTrue(fixture.controller.state.session.refining)
        assertEquals(1, fixture.refiner.requests.size)

        fixture.controller.userEdited("base native plus edit")
        fixture.refiner.complete(VoiceRefinementResult.Accepted("corrected", "model"))

        assertEquals("base native plus edit", fixture.controller.state.session.draft.text)
        assertEquals(VoiceCapturePhase.Idle, fixture.controller.state.session.phase)
        assertTrue(fixture.scheduler.task!!.cancelled)
    }

    @Test
    fun `timeout is best effort and late backend success cannot replace native text`() {
        val fixture = fixture(
            initialDraft = "base",
            audio = VoiceCapturedAudio(ByteArray(160), "audio/wav", durationMs = 1_000),
        )
        fixture.controller.start()
        fixture.recognizer.listener!!.onFinal("native")
        fixture.controller.stop()
        fixture.recognizer.listener!!.onEnd()

        fixture.scheduler.task!!.run()
        fixture.refiner.complete(VoiceRefinementResult.Accepted("late correction", "model"))

        assertEquals("base native", fixture.controller.state.session.draft.text)
        assertEquals(VoiceCapturePhase.Idle, fixture.controller.state.session.phase)
        assertTrue(fixture.refiner.call!!.cancelled)
    }

    @Test
    fun `screen disposal cancels and closes capture idempotently and rejects late permission`() {
        val pendingPermission = FakePermission(autoDecision = null)
        val fixture = fixture(permissionGateway = pendingPermission)
        fixture.controller.start()
        fixture.controller.close()
        pendingPermission.complete(VoicePermissionDecision.Granted)
        assertEquals(0, fixture.recognizer.startCalls)

        val active = fixture()
        active.controller.start()
        active.controller.close()
        active.controller.close()
        assertEquals(1, active.recognizer.session.cancelCalls)
        assertEquals(1, active.recognizer.session.closeCalls)
        assertNull(active.controller.state.session.sessionToken)
    }

    private data class Fixture(
        val controller: VoiceComposerController,
        val permission: FakePermission,
        val recognizer: FakeRecognizer,
        val refiner: FakeRefiner,
        val scheduler: FakeScheduler,
    )

    private fun fixture(
        initialDraft: String = "",
        permission: VoicePermissionDecision = VoicePermissionDecision.Granted,
        permissionGateway: FakePermission = FakePermission(permission),
        audio: VoiceCapturedAudio? = null,
        onDraft: (String) -> Unit = {},
    ): Fixture {
        val recognizer = FakeRecognizer(audio)
        val refiner = FakeRefiner()
        val scheduler = FakeScheduler()
        val controller = VoiceComposerController(
            initialDraft = initialDraft,
            permission = permissionGateway,
            recognizer = recognizer,
            refiner = refiner,
            scheduler = scheduler,
            projectPath = "/repo",
            onDraft = onDraft,
        )
        return Fixture(controller, permissionGateway, recognizer, refiner, scheduler)
    }

    private class FakePermission(
        private val autoDecision: VoicePermissionDecision?,
    ) : VoicePermissionGateway {
        private var callback: ((VoicePermissionDecision) -> Unit)? = null
        var openSettingsCalls = 0

        override fun request(callback: (VoicePermissionDecision) -> Unit) {
            this.callback = callback
            autoDecision?.let(callback)
        }

        override fun openSettings(): Boolean {
            openSettingsCalls++
            return true
        }

        fun complete(decision: VoicePermissionDecision) = callback?.invoke(decision)
    }

    private class FakeRecognizer(
        private val audio: VoiceCapturedAudio?,
    ) : VoiceRecognizerGateway {
        var available = true
        var startCalls = 0
        var listener: VoiceRecognitionListener? = null
        val sessions = mutableListOf<FakeRecognitionSession>()
        val session: FakeRecognitionSession
            get() = sessions.first()

        override fun isAvailable(): Boolean = available

        override fun start(
            sessionToken: Long,
            listener: VoiceRecognitionListener,
        ): VoiceRecognitionStartResult {
            startCalls++
            this.listener = listener
            return VoiceRecognitionStartResult.Started(
                FakeRecognitionSession(audio).also(sessions::add),
            )
        }
    }

    private class FakeRecognitionSession(
        private val audio: VoiceCapturedAudio?,
    ) : VoiceRecognitionSession {
        var stopCalls = 0
        var cancelCalls = 0
        var closeCalls = 0

        override fun stop() {
            stopCalls++
        }

        override fun cancel() {
            cancelCalls++
        }

        override fun finishSafeAudio(): VoiceCapturedAudio? = audio

        override fun close() {
            closeCalls++
        }
    }

    private class FakeRefiner : VoiceTranscriptRefiner {
        val requests = mutableListOf<VoiceRefinementRequest>()
        var callback: ((VoiceRefinementResult) -> Unit)? = null
        var call: FakeCancelable? = null

        override val available: Boolean = true

        override fun transcribe(
            request: VoiceRefinementRequest,
            callback: (VoiceRefinementResult) -> Unit,
        ): VoiceCancelable {
            requests += request
            this.callback = callback
            return FakeCancelable().also { call = it }
        }

        fun complete(result: VoiceRefinementResult) = callback?.invoke(result)
    }

    private class FakeScheduler : VoiceScheduler {
        var task: FakeScheduledTask? = null

        override fun schedule(delayMs: Long, block: () -> Unit): VoiceCancelable =
            FakeScheduledTask(block).also { task = it }
    }

    private open class FakeCancelable : VoiceCancelable {
        var cancelled = false
        override fun cancel() {
            cancelled = true
        }
    }

    private class FakeScheduledTask(
        private val block: () -> Unit,
    ) : FakeCancelable() {
        fun run() {
            if (!cancelled) block()
        }
    }
}
