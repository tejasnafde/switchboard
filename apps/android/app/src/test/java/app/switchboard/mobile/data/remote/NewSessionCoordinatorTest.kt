package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.StagedAttachment
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.remote.StartedSession
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionCoordinatorTest {
    @Test
    fun loadUsesExactBackendSettingsAndAppliesAuthoritativeDefaults() {
        val remote = FakeNewSessionRemote()
        val coordinator = coordinator(remote)

        coordinator.load()

        assertEquals(
            listOf(
                "chat.defaultRuntimeMode",
                "chat.defaultModel.claude-code",
                "chat.defaultProviderInstanceId",
            ),
            remote.settings.map { it.first },
        )
        remote.instances.single()(success("instances", listOf(instance("claude-work"))))
        remote.answerSetting("chat.defaultRuntimeMode", "accept-edits")
        remote.answerSetting("chat.defaultModel.claude-code", "future-claude")
        remote.answerSetting("chat.defaultProviderInstanceId", "claude-work")

        val state = coordinator.state.value
        assertEquals("accept-edits", state.runtimeMode.wire)
        assertEquals("future-claude", state.selectedModelId)
        assertTrue(state.modelOptions.first().authoritativeDefault)
        assertEquals("claude-work", state.selectedInstanceId)
        assertFalse(state.loadingDefaults)
    }

    @Test
    fun startOrdersCreateThenSessionThenDurableFirstMessageAndRetriesOnlyTheWrite() {
        val remote = FakeNewSessionRemote()
        val enqueueResults = ArrayDeque<EnqueueResult>().apply {
            add(EnqueueResult.StorageFailure("disk full"))
            add(durable("mob-id"))
        }
        val started = mutableListOf<NewSessionStarted>()
        val coordinator = coordinator(
            remote = remote,
            enqueue = NewSessionEnqueue { enqueueResults.removeFirst() },
            onStarted = started::add,
        )
        coordinator.updateFirstMessage("  Ship it  ")

        coordinator.submit()
        assertEquals("mob-id", remote.creates.single().first.id)
        assertNull(remote.creates.single().first.title)
        assertTrue(remote.starts.isEmpty())
        remote.creates.single().second(success("create", CommandBody(JsonNull)))
        assertEquals("mob-id", remote.starts.single().first.threadId)
        remote.starts.single().second(success("start", startedSession("mob-id")))

        assertEquals("disk full", coordinator.state.value.error)
        assertEquals("  Ship it  ", coordinator.state.value.firstMessage)
        assertTrue(started.isEmpty())

        coordinator.submit()

        assertEquals(1, remote.creates.size)
        assertEquals(1, remote.starts.size)
        assertEquals("mob-id", started.single().threadId)
        assertEquals("Repo", started.single().title)
    }

    @Test
    fun titleGenerationMatchesSharedReactNativeRules() {
        assertEquals("New conversation", NewSessionTitle.generate("```kotlin\ncode\n```"))
        assertEquals("Please fix this now", NewSessionTitle.generate("Please `ignore` fix\nthis  now"))
        assertEquals(
            "A comfortably long request that should stop at a…",
            NewSessionTitle.generate("A comfortably long request that should stop at a useful word boundary please"),
        )
    }

    private fun coordinator(
        remote: FakeNewSessionRemote,
        enqueue: NewSessionEnqueue = NewSessionEnqueue { durable("mob-id") },
        onStarted: (NewSessionStarted) -> Unit = {},
    ) = NewSessionCoordinator(
        connectionId = "machine",
        generation = 7,
        projectPath = "/repo",
        projectName = "Repo",
        remote = remote,
        enqueue = enqueue,
        ids = NewSessionIdSource { "mob-id" },
        clock = NewSessionClock { 10 },
        onStarted = onStarted,
    )

    private fun instance(id: String) = ProviderInstance(
        id = id,
        agentType = "claude-code",
        displayName = "Work",
        accentColor = null,
        authMode = "oauth_dir",
        envKeys = emptyList(),
        oauthDir = null,
        enabled = true,
        createdAt = 1,
        updatedAt = 1,
        raw = JsonObject(linkedMapOf()),
    )

    private fun startedSession(id: String) = StartedSession(
        threadId = id,
        provider = ProviderKind.Claude.wire,
        status = "idle",
        cwd = "/repo",
        sessionId = null,
        raw = JsonObject(linkedMapOf()),
    )

    private fun durable(id: String) = EnqueueResult.Durable(
        QueuedTurn(
            connectionId = "machine",
            threadId = id,
            origin = "origin",
            bubbleId = "remote_origin",
            text = "Ship it",
            attachments = emptyList<StagedAttachment>(),
            runtimeMode = "sandbox",
            createdAtMs = 10,
            attempts = 0,
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Pending,
        ),
    )

    private fun <T> success(operation: String, value: T) = RemoteResponse(
        RemoteRequestKey("machine", 7, operation),
        RemoteOutcome.Success(value),
    )
}

private class FakeNewSessionRemote : NewSessionRemote {
    val instances = mutableListOf<(RemoteResponse<List<ProviderInstance>>) -> Unit>()
    val settings = mutableListOf<Pair<String, (RemoteResponse<String?>) -> Unit>>()
    val creates = mutableListOf<Pair<CreateConversation, (RemoteResponse<CommandBody>) -> Unit>>()
    val starts = mutableListOf<Pair<StartSession, (RemoteResponse<StartedSession>) -> Unit>>()

    override fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit) {
        instances += callback
    }

    override fun getSetting(key: String, callback: (RemoteResponse<String?>) -> Unit) {
        settings += key to callback
    }

    override fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        creates += input to callback
    }

    override fun startSession(
        input: StartSession,
        callback: (RemoteResponse<StartedSession>) -> Unit,
    ) {
        starts += input to callback
    }

    fun answerSetting(key: String, value: String?) {
        settings.first { it.first == key }.second(
            RemoteResponse(
                RemoteRequestKey("machine", 7, key),
                RemoteOutcome.Success(value),
            ),
        )
    }
}
