package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.CreateConversation
import app.switchboard.mobile.domain.remote.ModelCatalogReconcile
import app.switchboard.mobile.domain.remote.ModelOption
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
import app.switchboard.mobile.domain.remote.WorktreeCreationCommand
import app.switchboard.mobile.domain.remote.WorktreeCreationOwner
import app.switchboard.mobile.domain.remote.WorktreeCreationPhase
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import app.switchboard.mobile.domain.remote.WorktreeCreationStatus
import app.switchboard.mobile.domain.remote.WorktreeLaunchAgent
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy
import app.switchboard.mobile.domain.remote.WorktreeStartupReceipt
import java.io.Closeable
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

    /** An instance's live catalog before any session exists. Optional: older
     *  backends have no `provider:list-catalog` handler, so a coordinator
     *  must keep working (static list) if this is never called or always fails. */
    fun listCatalog(
        agentType: String,
        instanceId: String?,
        callback: (RemoteResponse<List<ModelOption>?>) -> Unit,
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

fun interface WorktreeCreationIdSource {
    fun nextCreationId(): String
}

interface NewSessionWorktreeCreationPort {
    fun submit(
        command: WorktreeCreationCommand,
        callback: (RemoteResponse<WorktreeCreationSnapshot>) -> Unit,
    )

    fun get(
        creationId: String,
        callback: (RemoteResponse<WorktreeCreationSnapshot?>) -> Unit,
    )

    fun observe(observer: (WorktreeCreationSnapshot) -> Unit): Closeable
}

interface NewSessionWorktreeCreationStore {
    fun save(
        creation: WorktreeCreationRequest,
        completion: (Result<Unit>) -> Unit,
    )
    fun load(connectionId: String, projectPath: String): WorktreeCreationRequest?
    fun clear(creationId: String)
}

sealed interface NewSessionWorkspace {
    data object ParentCheckout : NewSessionWorkspace

    data class Worktree(
        val baseRef: String,
        val setupPolicy: WorktreeSetupPolicy,
    ) : NewSessionWorkspace
}

private object NoWorktreeCreationPort : NewSessionWorktreeCreationPort {
    override fun submit(
        command: WorktreeCreationCommand,
        callback: (RemoteResponse<WorktreeCreationSnapshot>) -> Unit,
    ) = Unit

    override fun get(
        creationId: String,
        callback: (RemoteResponse<WorktreeCreationSnapshot?>) -> Unit,
    ) = Unit

    override fun observe(observer: (WorktreeCreationSnapshot) -> Unit): Closeable = Closeable {}
}

object EmptyNewSessionWorktreeCreationStore : NewSessionWorktreeCreationStore {
    override fun save(
        creation: WorktreeCreationRequest,
        completion: (Result<Unit>) -> Unit,
    ) = completion(Result.failure(IllegalStateException("Worktree creation storage is unavailable")))
    override fun load(connectionId: String, projectPath: String): WorktreeCreationRequest? = null
    override fun clear(creationId: String) = Unit
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
    val worktreeAvailable: Boolean = false,
    val workspace: NewSessionWorkspace = NewSessionWorkspace.ParentCheckout,
    val worktreeRecord: WorktreeCreationSnapshot? = null,
    val error: String? = null,
)

data class NewSessionStarted(
    val threadId: String,
    val title: String,
    val projectPath: String,
    val worktreePath: String? = null,
    val branch: String? = null,
    val worktreeId: String? = null,
    val creationId: String? = null,
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
    private val worktrees: NewSessionWorktreeCreationPort = NoWorktreeCreationPort,
    private val worktreeStore: NewSessionWorktreeCreationStore = EmptyNewSessionWorktreeCreationStore,
    private val creationIds: WorktreeCreationIdSource = WorktreeCreationIdSource {
        "worktree-${ids.nextThreadId()}"
    },
    private val worktreeAvailable: Boolean = false,
    /** Rejection is expected against an older backend (no `provider:list-catalog`
     *  handler) - the static list stays, this just names the reason. */
    private val onCatalogProbeFailed: (String) -> Unit = {},
) : Closeable {
    private val mutableState = MutableStateFlow(
        NewSessionState(connectionId, projectPath, projectName, worktreeAvailable = worktreeAvailable),
    )
    val state = mutableState.asStateFlow()

    private var allInstances: List<ProviderInstance> = emptyList()
    private var defaultsRequest = 0L
    private var catalogRequest = 0L
    // Which instance's live catalog currently backs modelOptions, so switching
    // instances never leaves a different instance's models (or a selectedModelId
    // picked from them) sitting in state while a probe for the new one is in
    // flight, fails, or returns empty. catalogOwnerInstanceId is meaningful only
    // when catalogApplied is true - the resolved instance id itself can be null
    // (no profiles configured), which is a real, distinct owner from "no live
    // catalog has been applied yet".
    private var catalogApplied = false
    private var catalogOwnerInstanceId: String? = null
    private val catalogCache = mutableMapOf<String?, List<NewSessionModelOption>>()
    private var instanceTouched = false
    private var modelTouched = false
    private var requestedDefaultInstanceId: String? = null
    private var launch: Launch? = null
    private var worktreeRequest: WorktreeCreationRequest? = null
    private var worktreeBackendKnowledge = WorktreeBackendKnowledge.NotSubmitted
    private val worktreeObserver = worktrees.observe(::acceptWorktreeSnapshot)
    private var closed = false

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        worktreeObserver.close()
    }

    fun load() {
        worktreeStore.load(connectionId, projectPath)?.let { recovered ->
            worktreeRequest = recovered
            worktreeBackendKnowledge = WorktreeBackendKnowledge.Unknown
            mutableState.value = mutableState.value.copy(
                workspace = NewSessionWorkspace.Worktree(
                    baseRef = recovered.baseRef,
                    setupPolicy = recovered.setupPolicy,
                ),
                launchLocked = true,
                submitting = true,
            )
            queryWorktree(recovered.creationId)
        }
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
                val previousResolvedInstanceId = current.selectedInstanceId
                    ?: current.profiles.firstOrNull()?.id
                mutableState.value = current.copy(
                    loadingInstances = false,
                    profiles = profiles,
                    selectedInstanceId = selected,
                )
                // Defaults can resolve before this callback does (getSetting racing
                // listProviderInstances). If applyDefaults already probed the catalog
                // with a stale/null instance id, re-probe now that this callback has
                // resolved the real one - otherwise the earlier response is dropped
                // as stale (Line ~664) and nothing else ever re-asks.
                val resolvedInstanceId = selected ?: profiles.firstOrNull()?.id
                if (!mutableState.value.loadingDefaults && resolvedInstanceId != previousResolvedInstanceId) {
                    refreshCatalog()
                }
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
        // A live catalog is scoped to one provider's agentType; a different
        // provider's instance ids are a different namespace, so nothing here
        // should be treated as still "owning" the just-reset modelOptions.
        catalogApplied = false
        catalogOwnerInstanceId = null
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
        refreshCatalog()
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
    fun selectWorkspace(workspace: NewSessionWorkspace) {
        if (mutableState.value.launchLocked) return
        if (workspace is NewSessionWorkspace.Worktree && !worktreeAvailable) return
        mutableState.value = mutableState.value.copy(workspace = workspace, error = null)
    }

    @Synchronized
    fun submit() {
        if (mutableState.value.submitting) return
        if (mutableState.value.workspace is NewSessionWorkspace.Worktree) {
            submitWorktreeCreation()
            return
        }
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

    @Synchronized
    fun retryWorktreeCreation() {
        val request = worktreeRequest ?: return
        val snapshot = mutableState.value.worktreeRecord
        if (snapshot != null) {
            actOnWorktree(WorktreeCreationRecoveryAction.Retry)
        } else when (worktreeBackendKnowledge) {
            WorktreeBackendKnowledge.NotSubmitted,
            WorktreeBackendKnowledge.Absent,
            -> {
                mutableState.value = mutableState.value.copy(submitting = true, error = null)
                persistAndSubmitWorktree(request)
            }
            WorktreeBackendKnowledge.Unknown,
            WorktreeBackendKnowledge.Present,
            -> {
                mutableState.value = mutableState.value.copy(submitting = true, error = null)
                queryWorktree(request.creationId)
            }
        }
    }

    @Synchronized
    fun reconcileWorktreeCreation() {
        val request = worktreeRequest ?: return
        mutableState.value = mutableState.value.copy(error = null)
        queryWorktree(request.creationId)
    }

    @Synchronized
    fun useParentCheckout() {
        val request = worktreeRequest ?: return
        val snapshot = mutableState.value.worktreeRecord ?: return
        if (
            WorktreeCreationRecoveryAction.StartInProject !in snapshot.recoveryActions ||
            snapshot.status != WorktreeCreationStatus.Failed ||
            snapshot.phase != WorktreeCreationPhase.Materializing
        ) {
            return
        }
        val owner = request.owner as? WorktreeCreationOwner.Conversation ?: return
        val provider = NewSessionDecisions.providers
            .firstOrNull { it.agentType == request.launchAgent.provider }
            ?.kind
            ?: return fail("The saved worktree provider is no longer available.")
        val runtimeMode = RuntimeMode.entries
            .firstOrNull { it.wire == request.launchAgent.runtimeMode }
            ?: return fail("The saved worktree runtime mode is no longer available.")
        val parentLaunch = Launch(
            threadId = owner.conversationId,
            provider = provider,
            agentType = owner.agentType,
            runtimeMode = runtimeMode,
            instanceId = request.launchAgent.instanceId,
            modelId = request.launchAgent.model,
            message = request.launchAgent.prompt.orEmpty(),
            stage = LaunchStage.New,
        )
        worktreeStore.clear(request.creationId)
        worktreeRequest = null
        worktreeBackendKnowledge = WorktreeBackendKnowledge.NotSubmitted
        launch = parentLaunch
        mutableState.value = mutableState.value.copy(
            provider = provider,
            runtimeMode = runtimeMode,
            selectedInstanceId = request.launchAgent.instanceId,
            selectedModelId = request.launchAgent.model,
            workspace = NewSessionWorkspace.ParentCheckout,
            worktreeRecord = null,
            submitting = true,
            launchLocked = true,
            error = null,
        )
        create(parentLaunch)
    }

    @Synchronized
    fun cancelWorktreeCreation() {
        actOnWorktree(WorktreeCreationRecoveryAction.Cancel)
    }

    @Synchronized
    fun chooseWorktreeSetup(run: Boolean) {
        actOnWorktree(
            if (run) {
                WorktreeCreationRecoveryAction.ChooseSetupRun
            } else {
                WorktreeCreationRecoveryAction.ChooseSetupSkip
            },
        )
    }

    @Synchronized
    fun retainWorktree() {
        actOnWorktree(WorktreeCreationRecoveryAction.Retain)
    }

    @Synchronized
    fun removeWorktree() {
        actOnWorktree(WorktreeCreationRecoveryAction.Remove)
    }

    private fun submitWorktreeCreation() {
        val workspace = mutableState.value.workspace as? NewSessionWorkspace.Worktree ?: return
        val provider = mutableState.value.provider
        val agentType = NewSessionDecisions.providers.first { it.kind == provider }.agentType
        val request = worktreeRequest ?: WorktreeCreationRequest(
            creationId = creationIds.nextCreationId(),
            machineId = connectionId,
            projectPath = projectPath,
            baseRef = workspace.baseRef,
            branchSeed = mutableState.value.projectName,
            owner = WorktreeCreationOwner.Conversation(
                conversationId = ids.nextThreadId(),
                agentType = agentType,
            ),
            setupPolicy = workspace.setupPolicy,
            launchAgent = WorktreeLaunchAgent(
                provider = agentType,
                runtimeMode = mutableState.value.runtimeMode.wire,
                model = mutableState.value.selectedModelId,
                instanceId = mutableState.value.selectedInstanceId,
                prompt = mutableState.value.firstMessage.trim().ifEmpty { null },
            ),
            requestedAt = clock.nowMs(),
        ).also { worktreeRequest = it }
        mutableState.value = mutableState.value.copy(
            submitting = true,
            launchLocked = true,
            error = null,
        )
        persistAndSubmitWorktree(request)
    }

    private fun persistAndSubmitWorktree(request: WorktreeCreationRequest) {
        worktreeStore.save(request) { result ->
            synchronized(this) {
                if (worktreeRequest?.creationId != request.creationId) return@save
                result.fold(
                    onSuccess = {
                        worktreeBackendKnowledge = WorktreeBackendKnowledge.Unknown
                        submitWorktree(WorktreeCreationCommand.Ensure(request))
                    },
                    onFailure = { error ->
                        mutableState.value = mutableState.value.copy(
                            submitting = false,
                            error = error.message ?: "Could not save worktree creation for retry",
                        )
                    },
                )
            }
        }
    }

    private fun submitWorktree(command: WorktreeCreationCommand) {
        worktrees.submit(command) { response ->
            synchronized(this) {
                if (!accepts(response)) return@submit
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> acceptWorktreeSnapshot(outcome.value)
                    is RemoteOutcome.Failure -> {
                        mutableState.value = mutableState.value.copy(
                            submitting = true,
                            error = outcome.message,
                        )
                        worktreeRequest?.let { queryWorktree(it.creationId) }
                    }
                }
            }
        }
    }

    private fun queryWorktree(creationId: String) {
        worktrees.get(creationId) { response ->
            synchronized(this) {
                if (!accepts(response)) return@get
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> {
                        val snapshot = outcome.value
                        if (snapshot == null) {
                            worktreeBackendKnowledge = WorktreeBackendKnowledge.Absent
                            mutableState.value = mutableState.value.copy(
                                submitting = false,
                                error = "The backend has no record of this saved creation. Retry to submit it safely.",
                            )
                        } else {
                            acceptWorktreeSnapshot(snapshot)
                        }
                    }
                    is RemoteOutcome.Failure -> mutableState.value = mutableState.value.copy(
                        submitting = false,
                        error = outcome.message,
                    )
                }
            }
        }
    }

    @Synchronized
    private fun acceptWorktreeSnapshot(snapshot: WorktreeCreationSnapshot) {
        if (closed) return
        val request = worktreeRequest ?: return
        val current = mutableState.value.worktreeRecord
        if (snapshot.creationId != request.creationId || (current != null && snapshot.revision <= current.revision)) return
        worktreeBackendKnowledge = WorktreeBackendKnowledge.Present
        val authoritativeReady = snapshot.isAuthoritativeReady()
        mutableState.value = mutableState.value.copy(
            worktreeRecord = snapshot,
            submitting = snapshot.status == WorktreeCreationStatus.Pending,
            error = snapshot.error?.message ?: when {
                snapshot.status == WorktreeCreationStatus.Failed -> "Worktree creation failed."
                snapshot.status == WorktreeCreationStatus.Ready && !authoritativeReady ->
                    "Worktree creation completed without authoritative startup metadata. Retry reconciliation."
                else -> null
            },
        )
        if (
            snapshot.status == WorktreeCreationStatus.Cancelled ||
            (snapshot.status == WorktreeCreationStatus.RolledBack && snapshot.recoveryActions.isEmpty())
        ) {
            worktreeStore.clear(snapshot.creationId)
            return
        }
        if (!authoritativeReady) return
        worktreeStore.clear(snapshot.creationId)
        mutableState.value = mutableState.value.copy(submitting = false, error = null)
        val owner = snapshot.owner as WorktreeCreationOwner.Conversation
        onStarted(
            NewSessionStarted(
                threadId = owner.conversationId,
                title = mutableState.value.projectName,
                projectPath = snapshot.projectPath,
                worktreePath = snapshot.worktreePath,
                branch = snapshot.branch,
                worktreeId = snapshot.worktreeId,
                creationId = snapshot.creationId,
            ),
        )
    }

    private fun WorktreeCreationSnapshot.isAuthoritativeReady(): Boolean =
        status == WorktreeCreationStatus.Ready && owner is WorktreeCreationOwner.Conversation &&
            worktreeId != null && worktreePath != null && branch != null &&
            startupReceipt?.status == WorktreeStartupReceipt.Status.Succeeded &&
            startupReceipt.providerThreadId == owner.conversationId

    private fun actOnWorktree(action: WorktreeCreationRecoveryAction) {
        val snapshot = mutableState.value.worktreeRecord ?: return
        if (action !in snapshot.recoveryActions) return
        mutableState.value = mutableState.value.copy(submitting = true, error = null)
        submitWorktree(
            WorktreeCreationCommand.Act(
                creationId = snapshot.creationId,
                expectedRevision = snapshot.revision,
                action = action,
            ),
        )
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
        refreshCatalog()
    }

    /**
     * The instance's live catalog before any session exists - mirrors the
     * `liveModels` effect in NewSessionScreen.tsx, keyed the same way (agent
     * type + resolved instance id). Replaces the static [NewSessionState.modelOptions]
     * only once a non-empty catalog answers; a rejection (older backend with
     * no `provider:list-catalog` handler) or an empty answer keeps the static list.
     */
    @Synchronized
    private fun refreshCatalog() {
        val request = ++catalogRequest
        val provider = mutableState.value.provider
        val agentType = NewSessionDecisions.providers.first { it.kind == provider }.agentType
        val instanceId = mutableState.value.selectedInstanceId ?: mutableState.value.profiles.firstOrNull()?.id
        if (catalogApplied && catalogOwnerInstanceId != instanceId) {
            // modelOptions currently reflects a DIFFERENT instance's live catalog (an
            // earlier probe already applied one). If this probe fails or answers
            // empty, nothing else clears it, so the old instance's models - and a
            // selectedModelId picked from them - would stay submittable against the
            // new instance. Restore this instance's own cached catalog, or the
            // static fallback, before the probe goes out.
            val cached = catalogCache[instanceId]
            val restored = cached ?: NewSessionDecisions.models(provider)
            catalogApplied = cached != null
            catalogOwnerInstanceId = if (cached != null) instanceId else null
            mutableState.value = mutableState.value.copy(
                modelOptions = restored,
                selectedModelId = mutableState.value.selectedModelId
                    ?.takeIf { id -> restored.any { it.id == id } },
            )
        }
        remote.listCatalog(agentType, instanceId) { response ->
            synchronized(this@NewSessionCoordinator) {
                if (request != catalogRequest) return@listCatalog
                if (!accepts(response) || provider != mutableState.value.provider) return@listCatalog
                val currentInstanceId = mutableState.value.selectedInstanceId
                    ?: mutableState.value.profiles.firstOrNull()?.id
                if (currentInstanceId != instanceId) return@listCatalog
                val catalog = when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> outcome.value
                    is RemoteOutcome.Failure -> {
                        onCatalogProbeFailed(outcome.message)
                        null
                    }
                }
                if (catalog.isNullOrEmpty()) return@listCatalog
                applyCatalog(agentType, catalog)
                // Cache the mapped NewSessionModelOption rows (not the raw ModelOption
                // response), so a later restore-before-probe can drop them straight
                // into modelOptions without re-deriving them.
                catalogCache[instanceId] = mutableState.value.modelOptions
                catalogApplied = true
                catalogOwnerInstanceId = instanceId
            }
        }
    }

    @Synchronized
    private fun applyCatalog(agentType: String, catalog: List<ModelOption>) {
        val covers = ModelCatalogReconcile.coversFor(agentType)
        val previousOptions = mutableState.value.modelOptions
        val reconciledModelId = ModelCatalogReconcile.reconcileSelectedModel(
            mutableState.value.selectedModelId,
            catalog,
            covers,
        )
        val mapped = catalog.map { row ->
            NewSessionModelOption(
                id = row.id,
                label = row.label,
                tier = row.tier,
                authoritativeDefault = previousOptions.any { it.id == row.id && it.authoritativeDefault },
            )
        }
        // reconcileSelectedModel returns the pick verbatim (e.g. "claude-opus-4-7"
        // even when only "claude-opus-4-7[1m]" covers it), but NewSessionScreen only
        // marks an option selected on an exact id match. Without the prior entry the
        // picker would show nothing selected while submit() still sends it. Keep the
        // prior selected (or, failing that, the prior authoritative-default) option
        // visible until a catalog row exists at that exact id.
        val preserved = reconciledModelId
            ?.takeIf { id -> mapped.none { it.id == id } }
            ?.let { id ->
                previousOptions.firstOrNull { it.id == id }
                    ?: previousOptions.firstOrNull { it.authoritativeDefault }
            }
        mutableState.value = mutableState.value.copy(
            modelOptions = if (preserved != null) listOf(preserved) + mapped else mapped,
            selectedModelId = reconciledModelId,
        )
    }

    private fun create(value: Launch) {
        remote.createConversation(
            CreateConversation(
                id = value.threadId,
                projectPath = projectPath,
                agentType = value.agentType,
                title = null,
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
                title = mutableState.value.projectName,
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
        !closed && response.key.connectionId == connectionId && response.key.generation == generation

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

    private enum class WorktreeBackendKnowledge { NotSubmitted, Unknown, Absent, Present }

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

    override fun listCatalog(
        agentType: String,
        instanceId: String?,
        callback: (RemoteResponse<List<ModelOption>?>) -> Unit,
    ) = client.listCatalog(agentType, instanceId, callback).let { Unit }
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
