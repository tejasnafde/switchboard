package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.AnswerQuestion
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.ArchiveConversationResult
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.CurrentBranchResult
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.ForkConversationOutcome
import app.switchboard.mobile.domain.remote.ForkConversationRequest
import app.switchboard.mobile.domain.remote.ImageInput
import app.switchboard.mobile.domain.iap.IapDiscoveredTarget
import app.switchboard.mobile.domain.remote.LoadedSession
import app.switchboard.mobile.domain.remote.MessageSearchResult
import app.switchboard.mobile.domain.remote.MarkReadResult
import app.switchboard.mobile.domain.remote.ModelOption
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.ProviderSkill
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchRequest
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchResult
import app.switchboard.mobile.domain.remote.decodeProviderInstanceSwitch
import app.switchboard.mobile.domain.remote.RemoteDecoders
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.remote.StartedSession
import app.switchboard.mobile.domain.remote.Workspace
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
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
import app.switchboard.mobile.protocol.RuntimeEventPayload

object BackendChannels {
    const val ServerVersion = "server:version"
    const val GetProjects = "app:get-projects"
    const val GetConversations = "app:get-conversations"
    const val ListWorkspaces = "app:workspace-list"
    const val LoadSession = "app:load-session-by-id"
    const val SearchMessages = "app:search-messages"
    const val RenameConversation = "app:rename-conversation"
    const val ArchiveConversation = "app:archive-conversation"
    const val CreateConversation = "app:create-conversation"
    const val ForkConversation = "app:fork-conversation"
    const val GetConversationFork = "app:get-conversation-fork"
    const val MarkRead = "app:mark-read"
    const val GetSetting = "settings:get"
    const val SetSetting = "settings:set"
    const val CurrentBranch = "git:current-branch"
    const val StartSession = "provider:start-session"
    const val SendTurn = "provider:send-turn"
    const val Interrupt = "provider:interrupt"
    const val StopSession = "provider:stop-session"
    const val SwitchInstance = "provider:switch-instance"
    const val ListSkills = "provider:list-skills"
    const val ListModels = "provider:list-models"
    const val ListProviderInstances = "provider-instances:list"
    const val SetRuntimeMode = "provider:set-runtime-mode"
    const val SetModel = "provider:set-model"
    const val RespondToRequest = "provider:respond-to-request"
    const val AnswerQuestion = "provider:answer-question"
    const val ProviderEvents = "provider:event"
    const val PushRegister = "push:register"
    const val PushUnregister = "push:unregister"
    const val PushViewing = "push:viewing"
    const val WorktreeCreationCreate = "worktree-creation:create"
    const val WorktreeCreationGet = "worktree-creation:get"
    const val WorktreeCreationAct = "worktree-creation:act"
    const val WorktreeCreationProgress = "worktree-creation:progress"
    const val ListIapTargets = "machines:list-iap-targets"
}

class SwitchboardRemoteClient(
    val connectionId: String,
    private val rpc: RemoteRpc,
) : MessageSearchRemote, GitContextRemote {
    fun listIapTargets(callback: (RemoteResponse<List<IapDiscoveredTarget>>) -> Unit) =
        call(BackendChannels.ListIapTargets, decoder = RemoteDecoders::iapTargets, callback = callback)

    fun serverVersion(callback: (RemoteResponse<String>) -> Unit) =
        call(BackendChannels.ServerVersion, decoder = {
            (it as? JsonString)?.value ?: error("Expected server version string")
        }, callback = callback)

    fun getProjects(callback: (RemoteResponse<List<Project>>) -> Unit) =
        call(BackendChannels.GetProjects, decoder = RemoteDecoders::projects, callback = callback)

    fun getConversations(
        projectPath: String,
        callback: (RemoteResponse<List<Conversation>>) -> Unit,
    ) = call(
        BackendChannels.GetConversations,
        array(JsonString(projectPath)),
        RemoteDecoders::conversations,
        callback,
    )

    override fun searchMessages(
        query: String,
        callback: (RemoteResponse<List<MessageSearchResult>>) -> Unit,
    ): RequestSubmission = call(
        BackendChannels.SearchMessages,
        array(JsonString(query)),
        RemoteDecoders::messageSearch,
        callback,
    )

    fun listWorkspaces(callback: (RemoteResponse<List<Workspace>>) -> Unit) =
        call(BackendChannels.ListWorkspaces, decoder = RemoteDecoders::workspaces, callback = callback)

    fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit) =
        call(
            BackendChannels.ListProviderInstances,
            decoder = RemoteDecoders::providerInstances,
            callback = callback,
        )

    fun loadSession(
        conversationId: String,
        limit: Long? = null,
        callback: (RemoteResponse<LoadedSession>) -> Unit,
    ): RequestSubmission {
        val options = linkedMapOf<String, JsonValue>()
        if (limit != null) options["limit"] = JsonNumber(limit.toString())
        return call(
            BackendChannels.LoadSession,
            array(JsonString(conversationId), JsonObject(options)),
            RemoteDecoders::loadedSession,
            callback,
        )
    }

    fun renameConversation(
        conversationId: String,
        title: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.RenameConversation,
        array(JsonString(conversationId), JsonString(title)),
        callback,
    )

    fun archiveConversation(
        conversationId: String,
        callback: (RemoteResponse<ArchiveConversationResult>) -> Unit,
    ) = call(
        BackendChannels.ArchiveConversation,
        array(JsonString(conversationId)),
        ::decodeArchiveConversation,
        callback,
    )

    fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.CreateConversation,
        array(
            obj(
                "id" to JsonString(input.id),
                "projectPath" to JsonString(input.projectPath),
                "agentType" to JsonString(input.agentType),
                "title" to input.title.jsonStringOrNull(),
                "worktreePath" to input.worktreePath.jsonStringOrNull(),
                "worktreeBranch" to input.worktreeBranch.jsonStringOrNull(),
            ),
        ),
        callback,
    )

    fun forkConversation(
        input: ForkConversationRequest,
        callback: (RemoteResponse<ForkConversationOutcome>) -> Unit,
    ) = call(
        BackendChannels.ForkConversation,
        array(input.raw),
        ConversationForkWire::outcome,
        callback,
    )

    fun getConversationFork(
        input: ForkConversationRequest,
        callback: (RemoteResponse<ForkConversationOutcome?>) -> Unit,
    ) = call(
        BackendChannels.GetConversationFork,
        array(obj(
            "requestId" to JsonString(input.requestId),
            "sourceConversationId" to JsonString(input.sourceConversationId),
        )),
        { value -> if (value == null || value === JsonNull) null else ConversationForkWire.outcome(value) },
        callback,
    )

    fun markRead(
        threadId: String,
        callback: (RemoteResponse<MarkReadResult>) -> Unit,
    ) = call(
        BackendChannels.MarkRead,
        array(JsonString(threadId)),
        RemoteDecoders::markRead,
        callback,
    )

    fun registerPush(
        token: String,
        label: String,
        clientRef: String,
        callback: (PushBackendResult) -> Unit,
    ) = pushCommand(
        BackendChannels.PushRegister,
        array(JsonString(token), JsonString(label), JsonString(clientRef)),
        callback,
    )

    fun unregisterPush(
        token: String,
        callback: (PushBackendResult) -> Unit,
    ) = pushCommand(
        BackendChannels.PushUnregister,
        array(JsonString(token)),
        callback,
    )

    fun reportPushViewing(
        token: String,
        threadId: String?,
        callback: (PushBackendResult) -> Unit,
    ) = pushCommand(
        BackendChannels.PushViewing,
        array(JsonString(token), threadId?.let(::JsonString) ?: JsonNull),
        callback,
    )

    fun getSetting(
        key: String,
        callback: (RemoteResponse<String?>) -> Unit,
    ) = call(
        BackendChannels.GetSetting,
        array(JsonString(key)),
        RemoteDecoders::setting,
        callback,
    )

    fun setSetting(
        key: String,
        value: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.SetSetting,
        array(JsonString(key), JsonString(value)),
        callback,
    )

    override fun currentBranch(
        cwd: String,
        callback: (RemoteResponse<CurrentBranchResult>) -> Unit,
    ): RequestSubmission = call(
        BackendChannels.CurrentBranch,
        array(JsonString(cwd)),
        RemoteDecoders::currentBranch,
        callback,
    )

    fun startSession(
        input: StartSession,
        callback: (RemoteResponse<StartedSession>) -> Unit,
    ): RequestSubmission {
        val values = linkedMapOf<String, JsonValue>(
            "threadId" to JsonString(input.threadId),
            "provider" to JsonString(input.provider.wire),
            "cwd" to JsonString(input.cwd),
        )
        input.model?.let { values["model"] = JsonString(it) }
        input.runtimeMode?.let { values["runtimeMode"] = JsonString(it.wire) }
        input.resumeSessionId?.let { values["resumeSessionId"] = JsonString(it) }
        input.instanceId?.let { values["instanceId"] = JsonString(it) }
        return call(
            BackendChannels.StartSession,
            array(JsonObject(values)),
            RemoteDecoders::startedSession,
            callback,
        )
    }

    fun createWorktreeCreation(
        request: WorktreeCreationRequest,
        callback: (RemoteResponse<WorktreeCreationSnapshot>) -> Unit,
    ): RequestSubmission = call(
        BackendChannels.WorktreeCreationCreate,
        array(WorktreeCreationWire.encodeRequest(request)),
        WorktreeCreationWire::decodeSnapshot,
        callback,
    )

    fun getWorktreeCreation(
        creationId: String,
        callback: (RemoteResponse<WorktreeCreationSnapshot?>) -> Unit,
    ): RequestSubmission = call(
        BackendChannels.WorktreeCreationGet,
        array(WorktreeCreationWire.encodeGet(creationId, connectionId)),
        { value -> if (value == null || value === JsonNull) null else WorktreeCreationWire.decodeSnapshot(value) },
        callback,
    )

    fun actOnWorktreeCreation(
        creationId: String,
        expectedRevision: Long,
        action: WorktreeCreationRecoveryAction,
        callback: (RemoteResponse<WorktreeCreationSnapshot>) -> Unit,
    ): RequestSubmission = call(
        BackendChannels.WorktreeCreationAct,
        array(WorktreeCreationWire.encodeAction(creationId, connectionId, expectedRevision, action)),
        WorktreeCreationWire::decodeSnapshot,
        callback,
    )

    fun onWorktreeCreationProgress(listener: (String) -> Unit): Cancelable =
        rpc.onChannelEvent(BackendChannels.WorktreeCreationProgress) { scope, args ->
            if (scope.connectionId == connectionId && rpc.scope == scope) {
                WorktreeCreationWire.progressCreationId(args)?.let(listener)
            }
        }

    fun sendTurn(
        threadId: String,
        message: String,
        runtimeMode: RuntimeMode?,
        images: List<ImageInput>?,
        origin: String?,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.SendTurn,
        array(
            JsonString(threadId),
            JsonString(message),
            runtimeMode?.let { JsonString(it.wire) } ?: JsonNull,
            images?.let {
                JsonArray(
                    it.map { image ->
                        obj(
                            "url" to JsonString(image.url),
                            "mimeType" to image.mimeType.jsonStringOrNull(),
                        )
                    },
                )
            } ?: JsonNull,
            origin?.let(::JsonString) ?: JsonNull,
        ),
        callback,
    )

    fun interrupt(threadId: String, callback: (RemoteResponse<CommandBody>) -> Unit) =
        command(BackendChannels.Interrupt, array(JsonString(threadId)), callback)

    fun switchInstance(
        threadId: String,
        request: ProviderInstanceSwitchRequest,
        callback: (RemoteResponse<ProviderInstanceSwitchResult>) -> Unit,
    ) = call(
        BackendChannels.SwitchInstance,
        array(
            JsonString(threadId),
            obj(
                "targetInstanceId" to JsonString(request.targetInstanceId),
                "expectedCurrentInstanceId" to request.expectedCurrentInstanceId.jsonStringOrNull(),
            ),
        ),
        ::decodeProviderInstanceSwitch,
        callback,
    )

    fun listSkills(
        threadId: String,
        callback: (RemoteResponse<List<ProviderSkill>?>) -> Unit,
    ) = call(
        BackendChannels.ListSkills,
        array(JsonString(threadId)),
        RemoteDecoders::skills,
        callback,
    )

    fun listModels(
        threadId: String,
        callback: (RemoteResponse<List<ModelOption>?>) -> Unit,
    ) = call(
        BackendChannels.ListModels,
        array(JsonString(threadId)),
        RemoteDecoders::models,
        callback,
    )

    fun setRuntimeMode(
        threadId: String,
        mode: RuntimeMode,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.SetRuntimeMode,
        array(JsonString(threadId), JsonString(mode.wire)),
        callback,
    )

    fun setModel(
        threadId: String,
        model: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.SetModel,
        array(JsonString(threadId), JsonString(model)),
        callback,
    )

    fun respondToRequest(
        threadId: String,
        requestId: String,
        decision: ApprovalDecision,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.RespondToRequest,
        array(JsonString(threadId), JsonString(requestId), JsonString(decision.wire)),
        callback,
    )

    fun answerQuestion(
        input: AnswerQuestion,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = command(
        BackendChannels.AnswerQuestion,
        array(
            JsonString(input.threadId),
            JsonString(input.requestId),
            JsonArray(input.answers.map { row -> JsonArray(row.map(::JsonString)) }),
        ),
        callback,
    )

    fun onProviderEvent(
        listener: (TransportScope, RuntimeEventPayload) -> Unit,
    ): Cancelable = rpc.onRuntimeEvent { scope, event ->
        if (scope.connectionId == connectionId && rpc.scope == scope) listener(scope, event)
    }

    private fun command(
        channel: String,
        args: JsonArray,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ): RequestSubmission = call(channel, args, ::CommandBody, callback)

    private fun pushCommand(
        channel: String,
        args: JsonArray,
        callback: (PushBackendResult) -> Unit,
    ): RequestSubmission = call(channel, args, ::decodePushResult) { response ->
        callback(
            when (val outcome = response.outcome) {
                is RemoteOutcome.Success -> outcome.value
                is RemoteOutcome.Failure -> PushBackendResult.TransportFailure(outcome.message)
            },
        )
    }

    private fun decodePushResult(value: JsonValue?): PushBackendResult {
        val body = value as? JsonObject ?: error("Expected push response object")
        val ok = (body.values["ok"] as? JsonBoolean)?.value
            ?: error("Expected push response ok field")
        if (ok) return PushBackendResult.Accepted
        val error = (body.values["error"] as? JsonString)?.value
            ?.takeIf(String::isNotBlank)
            ?: "Backend rejected push request"
        return PushBackendResult.Rejected(error)
    }

    private fun decodeArchiveConversation(value: JsonValue?): ArchiveConversationResult {
        val body = value as? JsonObject ?: error("Expected archive response object")
        val ok = (body.values["ok"] as? JsonBoolean)?.value
            ?: error("Expected archive response ok field")
        val archived = (body.values["archived"] as? JsonBoolean)?.value
            ?: error("Expected archive response archived field")
        if (ok && archived) return ArchiveConversationResult.Archived
        val reason = (body.values["error"] as? JsonString)?.value
            ?.takeIf(String::isNotBlank)
            ?: "Backend did not confirm the archive"
        error(reason)
    }

    private fun <T> call(
        channel: String,
        args: JsonArray = JsonArray(emptyList()),
        decoder: (JsonValue?) -> T,
        callback: (RemoteResponse<T>) -> Unit,
    ): RequestSubmission {
        val scope = rpc.scope
        if (scope == null || scope.connectionId != connectionId) {
            val key = RemoteRequestKey(connectionId, scope?.generation ?: -1, channel)
            callback(RemoteResponse(key, RemoteOutcome.Failure("Connection scope changed")))
            return RequestSubmission.Rejected(
                app.switchboard.mobile.platform.protocol.RpcFailure.ConnectionReplaced,
            )
        }
        val key = RemoteRequestKey(
            connectionId = connectionId,
            generation = scope.generation,
            operation = channel,
        )
        return rpc.invoke(scope, channel, args) { outcome ->
            val decoded = when (outcome) {
                is RpcOutcome.Failure -> RemoteOutcome.Failure(outcome.reason.toString())
                is RpcOutcome.Success -> try {
                    RemoteOutcome.Success(decoder(outcome.result))
                } catch (error: RuntimeException) {
                    RemoteOutcome.Failure(error.message ?: "Malformed response")
                }
            }
            callback(RemoteResponse(key, decoded))
        }
    }

    private fun array(vararg values: JsonValue): JsonArray = JsonArray(values.toList())

    private fun obj(vararg fields: Pair<String, JsonValue>): JsonObject =
        JsonObject(linkedMapOf(*fields))

    private fun String?.jsonStringOrNull(): JsonValue =
        this?.let(::JsonString) ?: JsonNull
}
