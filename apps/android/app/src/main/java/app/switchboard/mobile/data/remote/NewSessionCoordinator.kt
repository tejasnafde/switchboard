package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.NewSessionDecisions
import app.switchboard.mobile.domain.remote.NewSessionModelOption
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.remote.SessionDefaults
import app.switchboard.mobile.domain.remote.StartSession
import app.switchboard.mobile.domain.remote.StartedSession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

interface NewSessionRemote {
    fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit)

    fun getSetting(key: String, callback: (RemoteResponse<String?>) -> Unit)

    fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    )

    fun startSession(
        input: StartSession,
        callback: (RemoteResponse<StartedSession>) -> Unit,
    )
}

fun interface NewSessionEnqueue {
    fun enqueue(draft: OutgoingTurnDraft): EnqueueResult
}

fun interface NewSessionIdSource {
    fun nextThreadId(): String
}

fun interface NewSessionClock {
    fun nowMs(): Long
}

data class NewSessionState(
    val connectionId: String,
    val projectPath: String,
    val projectName: String,
    val provider: ProviderKind = ProviderKind.Claude,
    val runtimeMode: RuntimeMode = RuntimeMode.Sandbox,
    val profiles: List<ProviderInstance> = emptyList(),
    val selectedInstanceId: String? = null,
    val modelOptions: List<NewSessionModelOption> = NewSessionDecisions.models(ProviderKind.Claude),
    val selectedModelId: String? = null,
    val firstMessage: String = "",
    val loadingInstances: Boolean = true,
    val loadingDefaults: Boolean = true,
    val submitting: Boolean = false,
    val launchLocked: Boolean = false,
    val error: String? = null,
)

data class NewSessionStarted(
    val threadId: String,
    val title: String,
    val projectPath: String,
)

class NewSessionCoordinator(
    private val connectionId: String,
    private val generation: Long,
    private val projectPath: String,
    projectName: String,
    private val remote: NewSessionRemote,
    private val enqueue: NewSessionEnqueue,
    private val ids: NewSessionIdSource,
    private val clock: NewSessionClock,
    private val onStarted: (NewSessionStarted) -> Unit,
) {
    private val mutableState = MutableStateFlow(
        NewSessionState(connectionId, projectPath, projectName),
    )
    val state = mutableState.asStateFlow()

    private var allInstances: List<ProviderInstance> = emptyList()
    private var defaultsRequest = 0L
    private var instanceTouched = false
    private var modelTouched = false
    private var requestedDefaultInstanceId: String? = null
    private var launch: Launch? = null

    fun load() {
        remote.listProviderInstances { response ->
            synchronized(this) {
                if (!accepts(response)) return@listProviderInstances
                allInstances = (response.outcome as? RemoteOutcome.Success)?.value.orEmpty()
                val current = mutableState.value
                val profiles = NewSessionDecisions.profiles(allInstances, current.provider)
                val selected = if (instanceTouched) {
                    current.selectedInstanceId
                } else {
                    requestedDefaultInstanceId?.takeIf { requested ->
                        profiles.any { it.id == requested }
                    } ?: profiles.firstOrNull()?.id
                }
                mutableState.value = current.copy(
                    loadingInstances = false,
                    profiles = profiles,
                    selectedInstanceId = selected,
                )
            }
        }
        loadDefaults(mutableState.value.provider)
    }

    @Synchronized
    fun selectProvider(provider: ProviderKind) {
        if (mutableState.value.launchLocked) return
        if (provider == mutableState.value.provider) return
        instanceTouched = false
        modelTouched = false
        requestedDefaultInstanceId = null
        mutableState.value = mutableState.value.copy(
            provider = provider,
            profiles = NewSessionDecisions.profiles(allInstances, provider),
            selectedInstanceId = null,
            modelOptions = NewSessionDecisions.models(provider),
            selectedModelId = null,
            loadingDefaults = true,
            error = null,
        )
        loadDefaults(provider)
    }

    @Synchronized
    fun selectRuntimeMode(mode: RuntimeMode) {
        if (mutableState.value.launchLocked) return
        mutableState.value = mutableState.value.copy(runtimeMode = mode, error = null)
    }

    @Synchronized
    fun selectInstance(instanceId: String?) {
        if (mutableState.value.launchLocked) return
        instanceTouched = true
        val valid = instanceId?.takeIf { id -> mutableState.value.profiles.any { it.id == id } }
        mutableState.value = mutableState.value.copy(selectedInstanceId = valid, error = null)
    }

    @Synchronized
    fun selectModel(modelId: String?) {
        if (mutableState.value.launchLocked) return
        modelTouched = true
        val normalized = modelId?.takeIf(String::isNotBlank)
        mutableState.value = mutableState.value.copy(selectedModelId = normalized, error = null)
    }

    @Synchronized
    fun updateFirstMessage(message: String) {
        if (mutableState.value.launchLocked) return
        mutableState.value = mutableState.value.copy(firstMessage = message, error = null)
    }

    @Synchronized
    fun submit() {
        if (mutableState.value.submitting) return
        val existing = launch
        if (existing?.stage == LaunchStage.Started) {
            durableFirstMessage(existing)
            return
        }
        val provider = mutableState.value.provider
        val agentType = NewSessionDecisions.providers.first { it.kind == provider }.agentType
        val current = existing ?: Launch(
            threadId = ids.nextThreadId(),
            provider = provider,
            agentType = agentType,
            runtimeMode = mutableState.value.runtimeMode,
            instanceId = mutableState.value.selectedInstanceId,
            modelId = mutableState.value.selectedModelId,
            message = mutableState.value.firstMessage.trim(),
            stage = LaunchStage.New,
        ).also { launch = it }
        mutableState.value = mutableState.value.copy(submitting = true, error = null)
        if (current.stage == LaunchStage.Created) start(current) else create(current)
    }

    private fun loadDefaults(provider: ProviderKind) {
        val request = ++defaultsRequest
        val agentType = NewSessionDecisions.providers.first { it.kind == provider }.agentType
        val values = arrayOfNulls<String>(3)
        var remaining = 3
        fun accept(index: Int, response: RemoteResponse<String?>) {
            synchronized(this@NewSessionCoordinator) {
                if (!accepts(response) || request != defaultsRequest || provider != mutableState.value.provider) {
                    return
                }
                values[index] = (response.outcome as? RemoteOutcome.Success)?.value
                remaining -= 1
                if (remaining == 0) {
                    requestedDefaultInstanceId = values[2]
                    applyDefaults(
                        provider,
                        SessionDefaults(values[0], values[1], values[2]),
                    )
                }
            }
        }
        remote.getSetting(DEFAULT_RUNTIME_MODE_KEY) { accept(0, it) }
        remote.getSetting("$DEFAULT_MODEL_PREFIX$agentType") { accept(1, it) }
        remote.getSetting(DEFAULT_INSTANCE_ID_KEY) { accept(2, it) }
    }

    @Synchronized
    private fun applyDefaults(
        provider: ProviderKind,
        defaults: SessionDefaults = SessionDefaults(
            mutableState.value.runtimeMode.wire,
            mutableState.value.selectedModelId,
            requestedDefaultInstanceId,
        ),
    ) {
        if (provider != mutableState.value.provider) return
        val profiles = NewSessionDecisions.profiles(allInstances, provider)
        val resolved = NewSessionDecisions.resolveDefaults(provider, defaults, profiles)
        mutableState.value = mutableState.value.copy(
            runtimeMode = resolved.runtimeMode,
            profiles = profiles,
            selectedInstanceId = if (instanceTouched) {
                mutableState.value.selectedInstanceId
            } else {
                resolved.instanceId
            },
            modelOptions = if (modelTouched) {
                mutableState.value.modelOptions
            } else {
                resolved.modelOptions
            },
            selectedModelId = if (modelTouched) {
                mutableState.value.selectedModelId
            } else {
                resolved.modelId
            },
            loadingDefaults = false,
        )
    }

    private fun create(value: Launch) {
        remote.createConversation(
            CreateConversation(
                id = value.threadId,
                projectPath = projectPath,
                agentType = value.agentType,
                title = value.message.takeIf(String::isNotEmpty)?.let(NewSessionTitle::generate),
            ),
        ) { response ->
            synchronized(this) {
                if (!accepts(response) || launch?.threadId != value.threadId) {
                    return@createConversation
                }
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> fail(outcome.message)
                    is RemoteOutcome.Success -> {
                        value.stage = LaunchStage.Created
                        mutableState.value = mutableState.value.copy(launchLocked = true)
                        start(value)
                    }
                }
            }
        }
    }

    private fun start(value: Launch) {
        remote.startSession(
            StartSession(
                threadId = value.threadId,
                provider = value.provider,
                cwd = projectPath,
                model = value.modelId,
                runtimeMode = value.runtimeMode,
                instanceId = value.instanceId,
            ),
        ) { response ->
            synchronized(this) {
                if (!accepts(response) || launch?.threadId != value.threadId) return@startSession
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> fail(outcome.message)
                    is RemoteOutcome.Success -> {
                        value.stage = LaunchStage.Started
                        if (value.message.isEmpty()) finish(value) else durableFirstMessage(value)
                    }
                }
            }
        }
    }

    private fun durableFirstMessage(value: Launch) {
        mutableState.value = mutableState.value.copy(submitting = true, error = null)
        when (
            val result = enqueue.enqueue(
                OutgoingTurnDraft(
                    connectionId = connectionId,
                    threadId = value.threadId,
                    text = value.message,
                    attachments = emptyList<AttachmentDraft>(),
                    runtimeMode = value.runtimeMode.wire,
                    createdAtMs = clock.nowMs(),
                ),
            )
        ) {
            is EnqueueResult.Durable -> finish(value)
            is EnqueueResult.AttachmentFailure -> fail(result.reason)
            is EnqueueResult.StorageFailure -> fail(result.reason)
        }
    }

    @Synchronized
    private fun finish(value: Launch) {
        mutableState.value = mutableState.value.copy(submitting = false, error = null)
        onStarted(
            NewSessionStarted(
                threadId = value.threadId,
                title = value.message.takeIf(String::isNotEmpty)?.let(NewSessionTitle::generate)
                    ?: mutableState.value.projectName,
                projectPath = projectPath,
            ),
        )
    }

    @Synchronized
    private fun fail(message: String) {
        if (launch?.stage == LaunchStage.New) launch = null
        mutableState.value = mutableState.value.copy(submitting = false, error = message)
    }

    private fun accepts(response: RemoteResponse<*>): Boolean =
        response.key.connectionId == connectionId && response.key.generation == generation

    private data class Launch(
        val threadId: String,
        val provider: ProviderKind,
        val agentType: String,
        val runtimeMode: RuntimeMode,
        val instanceId: String?,
        val modelId: String?,
        val message: String,
        var stage: LaunchStage,
    )

    private enum class LaunchStage { New, Created, Started }

    companion object {
        const val DEFAULT_RUNTIME_MODE_KEY = "chat.defaultRuntimeMode"
        const val DEFAULT_MODEL_PREFIX = "chat.defaultModel."
        const val DEFAULT_INSTANCE_ID_KEY = "chat.defaultProviderInstanceId"
    }
}

class SwitchboardNewSessionRemote(
    private val client: SwitchboardRemoteClient,
) : NewSessionRemote {
    override fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit) =
        client.listProviderInstances(callback).let { Unit }

    override fun getSetting(key: String, callback: (RemoteResponse<String?>) -> Unit) =
        client.getSetting(key, callback).let { Unit }

    override fun createConversation(
        input: CreateConversation,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) = client.createConversation(input, callback).let { Unit }

    override fun startSession(
        input: StartSession,
        callback: (RemoteResponse<StartedSession>) -> Unit,
    ) = client.startSession(input, callback).let { Unit }
}

object NewSessionTitle {
    fun generate(firstMessage: String, maxLength: Int = 50): String {
        val cleaned = firstMessage
            .replace(Regex("```[\\s\\S]*?```"), "")
            .replace(Regex("`[^`]+`"), "")
            .replace(Regex("\\n+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (cleaned.isEmpty()) return "New conversation"
        if (cleaned.length <= maxLength) return cleaned
        val truncated = cleaned.take(maxLength)
        val lastSpace = truncated.lastIndexOf(' ')
        return if (lastSpace > maxLength * 0.5) {
            truncated.take(lastSpace) + "…"
        } else {
            "$truncated…"
        }
    }
}
