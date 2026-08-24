package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.AnswerQuestion
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.ArchiveConversationResult
import app.switchboard.mobile.domain.remote.BrowseDecisions
import app.switchboard.mobile.domain.remote.CommandFollowUp
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.ImageInput
import app.switchboard.mobile.domain.iap.IapDiscoveredTarget
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchRequest
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.push.PushBackendResult
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.RuntimeEventKind
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SwitchboardRemoteClientTest {
    @Test
    fun `IAP discovery uses the existing machine channel and decodes SSH config targets`() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val responses = mutableListOf<RemoteResponse<List<IapDiscoveredTarget>>>()
        rpc.reply(
            JsonArray(
                listOf(
                    obj(
                        "alias" to JsonString("work-vm"),
                        "instance" to JsonString("vm-a"),
                        "project" to JsonString("project-a"),
                        "zone" to JsonString("asia-south1-b"),
                    ),
                ),
            ),
        )

        client.listIapTargets(responses::add)

        assertCall(rpc, "machines:list-iap-targets")
        assertEquals(
            IapDiscoveredTarget("work-vm", "vm-a", "project-a", "asia-south1-b"),
            (responses.single().outcome as RemoteOutcome.Success).value.single(),
        )
    }

    @Test
    fun `push commands preserve arguments and parse domain rejection inside successful response`() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val results = mutableListOf<PushBackendResult>()

        rpc.reply(obj("ok" to JsonBoolean(true)))
        client.registerPush("ExpoPushToken[token]", "phone", "mac-a", results::add)
        assertCall(
            rpc,
            "push:register",
            JsonString("ExpoPushToken[token]"),
            JsonString("phone"),
            JsonString("mac-a"),
        )
        assertEquals(PushBackendResult.Accepted, results.last())

        rpc.reply(obj("ok" to JsonBoolean(false), "error" to JsonString("not supported")))
        client.unregisterPush("ExpoPushToken[token]", results::add)
        assertCall(rpc, "push:unregister", JsonString("ExpoPushToken[token]"))
        assertEquals(PushBackendResult.Rejected("not supported"), results.last())

        rpc.reply(obj("ok" to JsonBoolean(true)))
        client.reportPushViewing("ExpoPushToken[token]", "thread-1", results::add)
        assertCall(
            rpc,
            "push:viewing",
            JsonString("ExpoPushToken[token]"),
            JsonString("thread-1"),
        )

        rpc.reply(obj("ok" to JsonBoolean(true)))
        client.reportPushViewing("ExpoPushToken[token]", null, results::add)
        assertCall(
            rpc,
            "push:viewing",
            JsonString("ExpoPushToken[token]"),
            JsonNull,
        )
    }

    @Test
    fun `malformed push success body is a nonfatal transport failure`() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val results = mutableListOf<PushBackendResult>()
        rpc.reply(obj("future" to JsonBoolean(true)))

        client.registerPush("ExpoPushToken[token]", "phone", "mac-a", results::add)

        assertTrue(results.single() is PushBackendResult.TransportFailure)
    }

    @Test
    fun browsingAndSettingsUseTheExistingBackendChannelsAndArgumentShapes() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)

        rpc.reply(JsonString("0.5.0"))
        client.serverVersion {}
        assertCall(rpc, "server:version")

        rpc.reply(JsonArray(emptyList()))
        client.getProjects {}
        assertCall(rpc, "app:get-projects")

        rpc.reply(JsonArray(emptyList()))
        client.getConversations("/repo") {}
        assertCall(rpc, "app:get-conversations", JsonString("/repo"))

        rpc.reply(JsonArray(emptyList()))
        client.listWorkspaces {}
        assertCall(rpc, "app:workspace-list")

        rpc.reply(loadedSessionJson())
        client.loadSession("thread-1", limit = 60) {}
        assertCall(
            rpc,
            "app:load-session-by-id",
            JsonString("thread-1"),
            obj("limit" to JsonNumber("60")),
        )

        rpc.reply(JsonString("sandbox"))
        client.getSetting("default-runtime-mode") {}
        assertCall(rpc, "settings:get", JsonString("default-runtime-mode"))

        rpc.reply(obj("ok" to JsonBoolean(true)))
        client.setSetting("theme", "dark") {}
        assertCall(rpc, "settings:set", JsonString("theme"), JsonString("dark"))

        rpc.reply(obj("ok" to JsonBoolean(true), "branch" to JsonString("main")))
        client.currentBranch("/repo") {}
        assertCall(rpc, "git:current-branch", JsonString("/repo"))
    }

    @Test
    fun `global message search uses the desktop FTS channel and decodes route metadata`() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val responses = mutableListOf<RemoteResponse<List<app.switchboard.mobile.domain.remote.MessageSearchResult>>>()
        rpc.reply(
            JsonArray(
                listOf(
                    obj(
                        "messageId" to JsonString("message-1"),
                        "conversationId" to JsonString("thread-1"),
                        "role" to JsonString("user"),
                        "content" to JsonString("full body"),
                        "snippet" to JsonString("...**native** body..."),
                        "conversationTitle" to JsonString("Native app"),
                        "projectPath" to JsonString("/repo"),
                        "agentType" to JsonString("codex"),
                        "worktreePath" to JsonNull,
                        "worktreeBranch" to JsonNull,
                    ),
                ),
            ),
        )

        client.searchMessages("native body", responses::add)

        assertCall(rpc, "app:search-messages", JsonString("native body"))
        val result = (responses.single().outcome as RemoteOutcome.Success).value.single()
        assertEquals("thread-1", result.conversationId)
        assertEquals("/repo", result.projectPath)
    }

    @Test
    fun conversationAndProviderCommandsPreserveEveryPositionalArgument() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val commandBody = obj("ok" to JsonBoolean(true), "future" to JsonString("kept"))

        rpc.reply(commandBody)
        client.createConversation(
            CreateConversation(
                id = "thread-1",
                projectPath = "/repo",
                agentType = "claude-code",
                title = "New chat",
                worktreePath = null,
                worktreeBranch = null,
            ),
        ) {}
        assertCall(
            rpc,
            "app:create-conversation",
            obj(
                "id" to JsonString("thread-1"),
                "projectPath" to JsonString("/repo"),
                "agentType" to JsonString("claude-code"),
                "title" to JsonString("New chat"),
                "worktreePath" to JsonNull,
                "worktreeBranch" to JsonNull,
            ),
        )

        rpc.reply(commandBody)
        client.renameConversation("thread-1", "Renamed") {}
        assertCall(rpc, "app:rename-conversation", JsonString("thread-1"), JsonString("Renamed"))

        val archives = mutableListOf<RemoteResponse<ArchiveConversationResult>>()
        rpc.reply(obj("ok" to JsonBoolean(true), "archived" to JsonBoolean(true)))
        client.archiveConversation("thread-1", archives::add)
        assertCall(rpc, "app:archive-conversation", JsonString("thread-1"))
        assertEquals(
            ArchiveConversationResult.Archived,
            (archives.single().outcome as RemoteOutcome.Success).value,
        )

        rpc.reply(commandBody)
        client.markRead("thread-1") {}
        assertCall(rpc, "app:mark-read", JsonString("thread-1"))

        rpc.reply(startedSessionJson())
        client.startSession(
            StartSession(
                threadId = "thread-1",
                provider = ProviderKind.Claude,
                cwd = "/repo",
                model = "claude-sonnet-5",
                runtimeMode = RuntimeMode.Plan,
                resumeSessionId = "session-old",
                instanceId = "claude-work",
            ),
        ) {}
        assertCall(
            rpc,
            "provider:start-session",
            obj(
                "threadId" to JsonString("thread-1"),
                "provider" to JsonString("claude"),
                "cwd" to JsonString("/repo"),
                "model" to JsonString("claude-sonnet-5"),
                "runtimeMode" to JsonString("plan"),
                "resumeSessionId" to JsonString("session-old"),
                "instanceId" to JsonString("claude-work"),
            ),
        )

        rpc.reply(JsonNull)
        client.sendTurn(
            threadId = "thread-1",
            message = "",
            runtimeMode = null,
            images = listOf(ImageInput("data:image/png;base64,AA==", "image/png")),
            origin = "turn-origin",
        ) {}
        assertCall(
            rpc,
            "provider:send-turn",
            JsonString("thread-1"),
            JsonString(""),
            JsonNull,
            JsonArray(
                listOf(
                    obj(
                        "url" to JsonString("data:image/png;base64,AA=="),
                        "mimeType" to JsonString("image/png"),
                    ),
                ),
            ),
            JsonString("turn-origin"),
        )

        val switchResults = mutableListOf<RemoteResponse<ProviderInstanceSwitchResult>>()
        rpc.reply(
            obj(
                "ok" to JsonBoolean(true),
                "threadId" to JsonString("thread-1"),
                "provider" to JsonString("codex"),
                "previousInstanceId" to JsonString("codex-work"),
                "instanceId" to JsonString("codex-tejas"),
                "instanceName" to JsonString("Tejas"),
                "continuity" to JsonString("preserved"),
            ),
        )
        client.switchInstance(
            "thread-1",
            ProviderInstanceSwitchRequest("codex-tejas", "codex-work"),
            switchResults::add,
        )
        assertCall(
            rpc,
            "provider:switch-instance",
            JsonString("thread-1"),
            obj(
                "targetInstanceId" to JsonString("codex-tejas"),
                "expectedCurrentInstanceId" to JsonString("codex-work"),
            ),
        )
        assertTrue(
            (switchResults.single().outcome as RemoteOutcome.Success).value is
                ProviderInstanceSwitchResult.Success,
        )

        val commands = listOf(
            Triple("provider:interrupt", listOf(JsonString("thread-1")), { client.interrupt("thread-1") {} }),
            Triple(
                "provider:set-runtime-mode",
                listOf(JsonString("thread-1"), JsonString("accept-edits")),
                { client.setRuntimeMode("thread-1", RuntimeMode.AcceptEdits) {} },
            ),
            Triple(
                "provider:set-model",
                listOf(JsonString("thread-1"), JsonString("gpt-5.6-luna")),
                { client.setModel("thread-1", "gpt-5.6-luna") {} },
            ),
            Triple(
                "provider:respond-to-request",
                listOf(JsonString("thread-1"), JsonString("req-1"), JsonString("approve")),
                { client.respondToRequest("thread-1", "req-1", ApprovalDecision.Approve) {} },
            ),
            Triple(
                "provider:answer-question",
                listOf(
                    JsonString("thread-1"),
                    JsonString("question-1"),
                    JsonArray(listOf(JsonArray(listOf(JsonString("A"), JsonString("B"))))),
                ),
                {
                    client.answerQuestion(
                        AnswerQuestion("thread-1", "question-1", listOf(listOf("A", "B"))),
                    ) {}
                },
            ),
        )
        commands.forEach { (channel, args, invoke) ->
            rpc.reply(JsonNull)
            invoke()
            assertCall(rpc, channel, *args.toTypedArray())
        }
    }

    @Test
    fun archiveRequiresTheBackendToConfirmTheGlobalArchiveWrite() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val responses = mutableListOf<RemoteResponse<ArchiveConversationResult>>()

        rpc.reply(obj("ok" to JsonBoolean(true), "archived" to JsonBoolean(false)))
        client.archiveConversation("thread-1", responses::add)

        assertTrue(responses.single().outcome is RemoteOutcome.Failure)
    }

    @Test
    fun typedDecodersKeepUnknownFieldsAndParseSuccessfulDomainBodies() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val projects = mutableListOf<RemoteResponse<List<app.switchboard.mobile.domain.remote.Project>>>()
        rpc.reply(
            JsonArray(
                listOf(
                    obj(
                        "path" to JsonString("/repo"),
                        "name" to JsonString("Repo"),
                        "sessions" to JsonArray(emptyList()),
                        "workspaceId" to JsonString("workspace-b"),
                        "futureField" to JsonNumber("17"),
                    ),
                ),
            ),
        )
        client.getProjects(projects::add)

        val project = (projects.single().outcome as RemoteOutcome.Success).value.single()
        assertEquals(JsonNumber("17"), project.raw.values["futureField"])

        val read = mutableListOf<RemoteResponse<app.switchboard.mobile.domain.remote.MarkReadResult>>()
        rpc.reply(
            obj(
                "ok" to JsonBoolean(false),
                "at" to JsonNumber("123"),
                "error" to JsonString("display_unsupported"),
            ),
        )
        client.markRead("thread-1", read::add)
        val body = (read.single().outcome as RemoteOutcome.Success).value
        assertEquals(false, body.ok)
        assertEquals("display_unsupported", (body.raw.values["error"] as JsonString).value)
    }

    @Test
    fun providerListsAndEventsRemainTypedWithoutDroppingExtensions() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)

        rpc.reply(
            JsonArray(
                listOf(
                    obj(
                        "name" to JsonString("commit"),
                        "description" to JsonString("Commit changes"),
                        "source" to JsonString("claude-code"),
                        "future" to JsonBoolean(true),
                    ),
                ),
            ),
        )
        val skills = mutableListOf<RemoteResponse<List<app.switchboard.mobile.domain.remote.ProviderSkill>?>>()
        client.listSkills("thread-1", skills::add)
        assertCall(rpc, "provider:list-skills", JsonString("thread-1"))
        assertEquals("commit", ((skills.single().outcome as RemoteOutcome.Success).value!!).single().name)

        rpc.reply(
            JsonArray(
                listOf(
                    obj(
                        "id" to JsonString("gpt-5.6-luna"),
                        "label" to JsonString("GPT-5.6-Luna"),
                        "tier" to JsonString("fast"),
                    ),
                ),
            ),
        )
        client.listModels("thread-1") {}
        assertCall(rpc, "provider:list-models", JsonString("thread-1"))

        val events = mutableListOf<Pair<TransportScope, RuntimeEventPayload>>()
        val cancel = client.onProviderEvent { scope, event -> events += scope to event }
        rpc.emit(
            RuntimeEventPayload(
                type = "provider.future-event",
                threadId = "thread-1",
                kind = RuntimeEventKind.Extension,
                raw = obj(
                    "type" to JsonString("provider.future-event"),
                    "threadId" to JsonString("thread-1"),
                ),
            ),
        )
        assertEquals("provider.future-event", events.single().second.type)
        rpc.emit(
            TransportScope("pixel", "mac-a", 6),
            RuntimeEventPayload(
                type = "provider.stale-event",
                threadId = "thread-1",
                kind = RuntimeEventKind.Extension,
                raw = obj("type" to JsonString("provider.stale-event")),
            ),
        )
        assertEquals(1, events.size)
        cancel.cancel()
    }

    @Test
    fun providerInstancesUseTheExistingRedactedBackendContract() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        val responses = mutableListOf<RemoteResponse<List<app.switchboard.mobile.domain.remote.ProviderInstance>>>()
        rpc.reply(
            JsonArray(
                listOf(
                    obj(
                        "id" to JsonString("claude-work"),
                        "agentType" to JsonString("claude-code"),
                        "displayName" to JsonString("Work"),
                        "accentColor" to JsonNull,
                        "authMode" to JsonString("oauth_dir"),
                        "envKeys" to JsonArray(listOf(JsonString("ANTHROPIC_API_KEY"))),
                        "oauthDir" to JsonString("/credentials/work"),
                        "enabled" to JsonBoolean(true),
                        "createdAt" to JsonNumber("10"),
                        "updatedAt" to JsonNumber("20"),
                        "future" to JsonBoolean(true),
                    ),
                ),
            ),
        )

        client.listProviderInstances(responses::add)

        assertCall(rpc, "provider-instances:list")
        val instance = (responses.single().outcome as RemoteOutcome.Success).value.single()
        assertEquals("claude-code", instance.agentType)
        assertEquals(listOf("ANTHROPIC_API_KEY"), instance.envKeys)
        assertEquals(JsonBoolean(true), instance.raw.values["future"])
    }

    @Test
    fun requestIsRejectedBeforeItCanCrossIntoAnotherConnectionScope() {
        val rpc = FakeRemoteRpc()
        val client = SwitchboardRemoteClient("mac-a", rpc)
        rpc.scope = TransportScope("pixel", "mac-b", 8)
        val results = mutableListOf<RemoteResponse<List<app.switchboard.mobile.domain.remote.Project>>>()

        val submission = client.getProjects(results::add)

        assertTrue(submission is RequestSubmission.Rejected)
        assertTrue(results.single().outcome is RemoteOutcome.Failure)
        assertTrue(rpc.calls.isEmpty())
    }

    @Test
    fun repositoryDropsStaleGenerationsAndKeepsRefreshFailureSeparateFromCommandSuccess() {
        val repository = GenerationGuardedRemoteRepository()
        val old = RemoteRequestKey("mac-a", generation = 3, operation = "conversations:/repo")
        val current = RemoteRequestKey("mac-a", generation = 4, operation = "conversations:/repo")
        val accepted = mutableListOf<RemoteResponse<String>>()
        val otherConnection = RemoteRequestKey("mac-b", generation = 1, operation = "conversations:/repo")

        repository.begin(old)
        repository.begin(current)
        repository.begin(otherConnection)
        repository.accept(RemoteResponse(old, RemoteOutcome.Success("stale")), accepted::add)
        repository.accept(RemoteResponse(current, RemoteOutcome.Success("current")), accepted::add)
        repository.accept(
            RemoteResponse(otherConnection, RemoteOutcome.Success("other current")),
            accepted::add,
        )
        assertEquals(
            listOf("current", "other current"),
            accepted.map { (it.outcome as RemoteOutcome.Success).value },
        )

        val command = RemoteResponse(
            RemoteRequestKey("mac-a", 4, "rename:thread-1"),
            RemoteOutcome.Success(JsonNull as JsonValue),
        )
        val refresh = RemoteResponse<List<app.switchboard.mobile.domain.remote.Conversation>>(
            current,
            RemoteOutcome.Failure("refresh offline"),
        )
        var result: CommandFollowUp<JsonValue, List<app.switchboard.mobile.domain.remote.Conversation>>? =
            null
        repository.commandThenBestEffortRefresh(
            command = { it(command) },
            refresh = { it(refresh) },
            consumer = { result = it },
        )
        val completed = requireNotNull(result)
        assertTrue(completed.command.outcome is RemoteOutcome.Success)
        assertTrue(completed.followUp?.outcome is RemoteOutcome.Failure)
    }

    @Test
    fun projectGroupingAndConversationOrderingMatchTheReactNativeDecisions() {
        val workspaceA = workspace("a", sortOrder = 2, createdAt = 20)
        val workspaceB = workspace("b", sortOrder = 1, createdAt = 30)
        val projects = listOf(
            project("/one", "a"),
            project("/unknown", "deleted"),
            project("/two", "b"),
            project("/loose", null),
        )

        val groups = BrowseDecisions.groupProjects(projects, listOf(workspaceA, workspaceB))
        assertEquals(listOf("b", "a", null), groups.map { it.workspace?.id })
        assertEquals(listOf("/unknown", "/loose"), groups.last().projects.map { it.path })

        val sorted = BrowseDecisions.sortConversations(
            listOf(conversation("old", 10), conversation("new", 20), conversation("same", 20)),
        )
        assertEquals(listOf("new", "same", "old"), sorted.map { it.id })
    }

    private fun assertCall(rpc: FakeRemoteRpc, channel: String, vararg args: JsonValue) {
        assertEquals(FakeRemoteRpc.Call(channel, JsonArray(args.toList())), rpc.calls.last())
    }

    private fun obj(vararg fields: Pair<String, JsonValue>): JsonObject =
        JsonObject(linkedMapOf(*fields))

    private fun loadedSessionJson() = obj(
        "messages" to JsonArray(emptyList()),
        "meta" to JsonNull,
        "total" to JsonNumber("0"),
        "truncated" to JsonBoolean(false),
    )

    private fun startedSessionJson() = obj(
        "threadId" to JsonString("thread-1"),
        "provider" to JsonString("claude"),
        "status" to JsonString("idle"),
        "cwd" to JsonString("/repo"),
    )

    private fun workspace(id: String, sortOrder: Long, createdAt: Long) =
        app.switchboard.mobile.domain.remote.Workspace(
            id,
            id.uppercase(),
            null,
            sortOrder,
            createdAt,
            obj("id" to JsonString(id)),
        )

    private fun project(path: String, workspaceId: String?) =
        app.switchboard.mobile.domain.remote.Project(
            path,
            path,
            emptyList(),
            workspaceId,
            obj("path" to JsonString(path)),
        )

    private fun conversation(id: String, updatedAt: Long) =
        app.switchboard.mobile.domain.remote.Conversation(
            id = id,
            projectPath = "/repo",
            agentType = "claude-code",
            sessionId = null,
            title = id,
            createdAt = 0,
            updatedAt = updatedAt,
            worktreePath = null,
            worktreeBranch = null,
            raw = obj("id" to JsonString(id)),
        )

    private class FakeRemoteRpc : RemoteRpc {
        data class Call(val channel: String, val args: JsonArray)

        override var scope: TransportScope? = TransportScope("pixel", "mac-a", 7)
        val calls = mutableListOf<Call>()
        private val replies = ArrayDeque<JsonValue?>()
        private val listeners = mutableListOf<(TransportScope, RuntimeEventPayload) -> Unit>()
        private var requestId = 0L

        fun reply(value: JsonValue?) {
            replies += value
        }

        override fun invoke(
            expectedScope: TransportScope,
            channel: String,
            args: JsonArray,
            callback: (RpcOutcome) -> Unit,
        ): RequestSubmission {
            if (scope != expectedScope) {
                callback(
                    RpcOutcome.Failure(
                        app.switchboard.mobile.platform.protocol.RpcFailure.ConnectionReplaced,
                    ),
                )
                return RequestSubmission.Rejected(
                    app.switchboard.mobile.platform.protocol.RpcFailure.ConnectionReplaced,
                )
            }
            calls += Call(channel, args)
            callback(RpcOutcome.Success(replies.removeAt(0)))
            return RequestSubmission.Accepted(++requestId, scope!!)
        }

        override fun onRuntimeEvent(
            listener: (TransportScope, RuntimeEventPayload) -> Unit,
        ): Cancelable {
            listeners += listener
            return Cancelable { listeners -= listener }
        }

        fun emit(event: RuntimeEventPayload) {
            emit(scope!!, event)
        }

        fun emit(scope: TransportScope, event: RuntimeEventPayload) {
            listeners.toList().forEach { it(scope, event) }
        }
    }
}
