package app.switchboard.mobile.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.remote.BrowseCoordinator
import app.switchboard.mobile.data.remote.NewSessionClock
import app.switchboard.mobile.data.remote.NewSessionCoordinator
import app.switchboard.mobile.data.remote.NewSessionEnqueue
import app.switchboard.mobile.data.remote.NewSessionIdSource
import app.switchboard.mobile.data.remote.NewSessionState
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.SwitchboardBrowseRemote
import app.switchboard.mobile.data.remote.SwitchboardNewSessionRemote
import app.switchboard.mobile.data.thread.SwitchboardThreadSessionRemote
import app.switchboard.mobile.data.thread.ThreadEnqueuePort
import app.switchboard.mobile.data.thread.ThreadComposerPersistence
import app.switchboard.mobile.data.thread.ThreadSessionClock
import app.switchboard.mobile.data.thread.ThreadSessionCoordinator
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.OutboxUiAction
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.notification.PendingNotificationRoute
import app.switchboard.mobile.ui.browse.BrowseLoadState
import app.switchboard.mobile.ui.browse.BrowseConversationRecord
import app.switchboard.mobile.ui.browse.BrowseProjectRecord
import app.switchboard.mobile.ui.browse.BrowseRequest
import app.switchboard.mobile.ui.browse.BrowseRoute
import app.switchboard.mobile.ui.browse.BrowseScreen
import app.switchboard.mobile.ui.browse.BrowseState
import app.switchboard.mobile.ui.connections.ConnectionIntent
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.connections.ConnectionsPresenter
import app.switchboard.mobile.ui.connections.ConnectionsScreen
import app.switchboard.mobile.ui.connections.RuntimeConnectionsMapper
import app.switchboard.mobile.ui.newsession.NewSessionScreen
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.pairing.PairingScreen
import app.switchboard.mobile.ui.thread.ThreadLoadState
import app.switchboard.mobile.ui.thread.ThreadScreen
import app.switchboard.mobile.ui.thread.ThreadComposerPresentation
import app.switchboard.mobile.ui.thread.ThreadSessionScreen
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect

private val EmptyRuntimeStatuses = MutableStateFlow<Map<String, ConnectionRuntimeState>>(emptyMap())
private val EmptyComposerDrafts = MutableStateFlow<Map<ComposerDraftKey, ComposerDraft>>(emptyMap())
private val EmptyComposerErrors = MutableStateFlow<Map<ComposerDraftKey, String>>(emptyMap())
private val EmptyQueuedTurns = MutableStateFlow<List<QueuedTurn>>(emptyList())

@Composable
fun SwitchboardNavigation(
    connectionsState: ConnectionsLoadState,
    buildStamp: String,
    resolveEditForm: (String) -> PairingForm?,
    onConnectionIntent: (ConnectionIntent) -> Unit,
    onPairingIntent: suspend (PairingSaveIntent) -> PairingSaveResult,
    offlineSnapshot: OfflineSnapshot? = null,
    runtime: RootNavigationRuntime? = null,
    pendingNotificationRoute: PendingNotificationRoute? = null,
    notificationRouteWake: Long = 0,
    onNotificationRouteAccepted: (PendingNotificationRoute) -> Unit = {},
) {
    var navigationState by rememberSaveable { mutableStateOf(NavigationState.root()) }
    val runtimeStatuses by (runtime?.statuses ?: EmptyRuntimeStatuses).collectAsState()
    val visibleConnections = remember(connectionsState, runtimeStatuses) {
        RuntimeConnectionsMapper.overlay(connectionsState, runtimeStatuses)
    }

    LaunchedEffect(
        pendingNotificationRoute?.tapId,
        notificationRouteWake,
        visibleConnections,
        runtimeStatuses,
    ) {
        val pending = pendingNotificationRoute ?: return@LaunchedEffect
        val accepted = NotificationNavigationResolver.resolve(
            pending = pending,
            connections = visibleConnections,
            exactLeaseReady = runtime?.lease(pending.route.connectionId) != null,
        ) ?: return@LaunchedEffect
        navigationState = NavigationState.root().push(accepted)
        onNotificationRouteAccepted(pending)
    }

    fun navigateBack() {
        navigationState = navigationState.pop()
    }

    BackHandler(enabled = navigationState.canGoBack, onBack = ::navigateBack)

    when (val route = navigationState.current) {
        AppRoute.Connections -> ConnectionsScreen(
            presentation = ConnectionsPresenter.present(visibleConnections),
            buildStamp = buildStamp,
            onAdd = { navigationState = navigationState.push(AppRoute.Pair()) },
            onManualAdd = {
                navigationState = navigationState.push(AppRoute.Pair(startManual = true))
            },
            onEdit = { connectionId ->
                navigationState = navigationState.push(AppRoute.Pair(connectionId))
            },
            onConnectionIntent = { intent ->
                when (intent) {
                    is ConnectionIntent.Open -> {
                        navigationState = navigationState.push(
                            AppRoute.Browse(
                                connectionId = intent.connectionId,
                                connectionLabel = visibleConnections.labelFor(intent.connectionId),
                            ),
                        )
                    }

                    is ConnectionIntent.Connect -> runtime?.connect(intent.connectionId)
                        ?: onConnectionIntent(intent)

                    is ConnectionIntent.Disconnect -> runtime?.disconnect(intent.connectionId)
                        ?: onConnectionIntent(intent)

                    is ConnectionIntent.Remove -> runtime?.remove(intent.connectionId)
                        ?: onConnectionIntent(intent)

                    ConnectionIntent.Retry -> onConnectionIntent(intent)
                }
            },
        )

        is AppRoute.Pair -> PairingScreen(
            editConnectionId = route.editConnectionId,
            startManual = route.startManual,
            initialForm = route.editConnectionId?.let(resolveEditForm),
            onBack = ::navigateBack,
            onSave = onPairingIntent,
            onSaved = ::navigateBack,
        )

        is AppRoute.Browse -> BrowseRouteHost(
            route = route,
            snapshot = offlineSnapshot ?: emptyOfflineSnapshot(),
            runtime = runtime,
            status = runtimeStatuses[route.connectionId],
            onProjectTap = { project ->
                navigationState = navigationState.push(
                    AppRoute.Browse(
                        connectionId = route.connectionId,
                        connectionLabel = route.connectionLabel,
                        projectPath = project.path,
                        projectName = project.name,
                    ),
                )
            },
            onSessionTap = { conversation ->
                navigationState = navigationState.push(
                    AppRoute.Thread(
                        connectionId = route.connectionId,
                        connectionLabel = route.connectionLabel,
                        threadId = conversation.id,
                        projectPath = conversation.projectPath,
                        title = conversation.title,
                    ),
                )
            },
            onNewSession = { projectPath, projectName ->
                navigationState = navigationState.push(
                    AppRoute.NewSession(
                        connectionId = route.connectionId,
                        connectionLabel = route.connectionLabel,
                        projectPath = projectPath,
                        projectName = projectName,
                    ),
                )
            },
            onBack = ::navigateBack,
        )

        is AppRoute.NewSession -> NewSessionRouteHost(
            route = route,
            runtime = runtime,
            status = runtimeStatuses[route.connectionId],
            onStarted = { started ->
                navigationState = navigationState.replace(
                    AppRoute.Thread(
                        connectionId = route.connectionId,
                        connectionLabel = route.connectionLabel,
                        threadId = started.threadId,
                        projectPath = started.projectPath,
                        title = started.title,
                    ),
                )
            },
            onBack = ::navigateBack,
        )

        is AppRoute.Thread -> ThreadRouteHost(
            route = route,
            runtime = runtime,
            status = runtimeStatuses[route.connectionId],
            onBack = ::navigateBack,
        )
    }
}

@Composable
private fun BrowseRouteHost(
    route: AppRoute.Browse,
    snapshot: OfflineSnapshot,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    onProjectTap: (Project) -> Unit,
    onSessionTap: (Conversation) -> Unit,
    onNewSession: (String, String) -> Unit,
    onBack: () -> Unit,
) {
    val lease = remember(runtime, route.connectionId, status) {
        runtime?.lease(route.connectionId)
    }
    val browseRoute = route.projectPath?.let { path ->
        BrowseRoute.Conversations(path, requireNotNull(route.projectName))
    } ?: BrowseRoute.Projects

    if (lease == null || runtime == null) {
        val fallback = RootNavigationPolicy.fallback(status)
        BrowseScreen(
            state = BrowseState(
                connectionId = route.connectionId,
                connectionLabel = route.connectionLabel,
                offlineSnapshot = snapshot,
                projects = fallback.toBrowseLoadState<BrowseProjectRecord>(),
                conversationsByProject = route.projectPath?.let { path ->
                    mapOf(path to fallback.toBrowseLoadState<BrowseConversationRecord>())
                }.orEmpty(),
            ),
            route = browseRoute,
            onProjectTap = onProjectTap,
            onSessionTap = onSessionTap,
            onRetry = { runtime?.retry(route.connectionId) },
            onNewSession = onNewSession,
            onBack = onBack,
        )
        return
    }

    ConnectedBrowseRoute(
        route = route,
        browseRoute = browseRoute,
        snapshot = snapshot,
        runtime = runtime,
        lease = lease,
        onProjectTap = onProjectTap,
        onSessionTap = onSessionTap,
        onNewSession = onNewSession,
        onBack = onBack,
    )
}

@Composable
private fun ConnectedBrowseRoute(
    route: AppRoute.Browse,
    browseRoute: BrowseRoute,
    snapshot: OfflineSnapshot,
    runtime: RootNavigationRuntime,
    lease: ReadyClientLease,
    onProjectTap: (Project) -> Unit,
    onSessionTap: (Conversation) -> Unit,
    onNewSession: (String, String) -> Unit,
    onBack: () -> Unit,
) {
    val initialCollapsed = remember(route.connectionId, snapshot) {
        runtime.collapsedWorkspaceIds(route.connectionId, snapshot)
    }
    val snapshotStore = remember(runtime, snapshot) {
        runtime.browseSnapshotStore(snapshot)
    }
    val coordinator = remember(route.connectionId, route.connectionLabel, lease.scope) {
        BrowseCoordinator(
            connectionId = route.connectionId,
            connectionLabel = route.connectionLabel,
            offlineSnapshot = snapshot,
            remote = SwitchboardBrowseRemote(lease.client),
            expectedGeneration = lease.scope.generation,
            initialCollapsedWorkspaceIds = initialCollapsed,
            collapsePreferenceStore = { connectionId, workspaceIds ->
                runtime.saveCollapsedWorkspaceIds(connectionId, workspaceIds)
            },
            snapshotStore = snapshotStore,
        )
    }
    val state by coordinator.state.collectAsState()
    val threadActivity by remember(runtime, lease.scope) {
        runtime.browseActivity(lease.scope)
    }.collectAsState()

    LaunchedEffect(coordinator) {
        coordinator.refreshProjects()
    }
    LaunchedEffect(coordinator, snapshot) {
        coordinator.updateOfflineSnapshot(snapshot)
    }
    LaunchedEffect(coordinator, threadActivity) {
        coordinator.updateThreadActivity(threadActivity)
    }
    LaunchedEffect(coordinator, route.projectPath) {
        route.projectPath?.let(coordinator::refreshConversations)
    }

    BrowseScreen(
        state = state,
        route = browseRoute,
        onProjectTap = onProjectTap,
        onSessionTap = onSessionTap,
        onRetry = { request ->
            when (request) {
                BrowseRequest.Projects -> coordinator.refreshProjects()
                is BrowseRequest.Conversations -> coordinator.refreshConversations(request.projectPath)
            }
        },
        onNewSession = onNewSession,
        onRenameConversation = coordinator::renameConversation,
        onToggleWorkspace = coordinator::toggleWorkspace,
        onBack = onBack,
    )
}

@Composable
private fun NewSessionRouteHost(
    route: AppRoute.NewSession,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    onStarted: (app.switchboard.mobile.data.remote.NewSessionStarted) -> Unit,
    onBack: () -> Unit,
) {
    val lease = remember(runtime, route.connectionId, status) {
        runtime?.lease(route.connectionId)
    }
    if (lease == null || runtime == null) {
        val message = when (val fallback = RootNavigationPolicy.fallback(status)) {
            LeaseFallback.Loading -> "Connecting to ${route.connectionLabel}"
            is LeaseFallback.Retryable -> fallback.message
        }
        NewSessionScreen(
            state = NewSessionState(
                connectionId = route.connectionId,
                projectPath = route.projectPath,
                projectName = route.projectName,
                loadingInstances = false,
                loadingDefaults = false,
                error = message,
            ),
            onBack = onBack,
            onProvider = {},
            onRuntimeMode = {},
            onInstance = {},
            onModel = {},
            onFirstMessage = {},
            onStart = { runtime?.retry(route.connectionId) },
        )
        return
    }

    val coordinator = remember(route, lease.scope, runtime) {
        NewSessionCoordinator(
            connectionId = route.connectionId,
            generation = lease.scope.generation,
            projectPath = route.projectPath,
            projectName = route.projectName,
            remote = SwitchboardNewSessionRemote(lease.client),
            enqueue = NewSessionEnqueue(runtime::enqueue),
            ids = NewSessionIdSource {
                "mob-${java.lang.Long.toString(System.currentTimeMillis(), 36)}"
            },
            clock = NewSessionClock(System::currentTimeMillis),
            onStarted = onStarted,
        )
    }
    val state by coordinator.state.collectAsState()
    LaunchedEffect(coordinator) { coordinator.load() }
    NewSessionScreen(
        state = state,
        onBack = onBack,
        onProvider = coordinator::selectProvider,
        onRuntimeMode = coordinator::selectRuntimeMode,
        onInstance = coordinator::selectInstance,
        onModel = coordinator::selectModel,
        onFirstMessage = coordinator::updateFirstMessage,
        onStart = coordinator::submit,
    )
}

@Composable
private fun ThreadRouteHost(
    route: AppRoute.Thread,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    onBack: () -> Unit,
) {
    val composerKey = remember(route.connectionId, route.threadId) {
        ComposerDraftKey(route.connectionId, route.threadId)
    }
    val composerDrafts by (runtime?.composerDrafts ?: EmptyComposerDrafts).collectAsState()
    val composerErrors by (runtime?.composerErrors ?: EmptyComposerErrors).collectAsState()
    val allQueuedTurns by (runtime?.queuedTurns ?: EmptyQueuedTurns).collectAsState()
    val savedDraft = composerDrafts[composerKey]
    val queuedTurns = remember(allQueuedTurns, route.connectionId, route.threadId) {
        allQueuedTurns.filter {
            it.connectionId == route.connectionId && it.threadId == route.threadId
        }
    }
    val lease = remember(runtime, route.connectionId, status) {
        runtime?.lease(route.connectionId)
    }
    if (lease == null || runtime == null) {
        val cached = runtime?.cachedThread(route.connectionId, route.threadId)
        val load = when (val fallback = RootNavigationPolicy.fallback(status)) {
            LeaseFallback.Loading -> ThreadLoadState.Loading(cached)
            is LeaseFallback.Retryable -> ThreadLoadState.Failed(fallback.message, cached)
        }
        var localDraft by remember(route.connectionId, route.threadId) {
            mutableStateOf(savedDraft ?: ComposerDraft(composerKey))
        }
        LaunchedEffect(savedDraft) {
            if (savedDraft != null) localDraft = savedDraft
        }
        ThreadScreen(
            threadId = route.threadId,
            title = route.title,
            backendLabel = route.connectionLabel,
            loadState = load,
            onRetry = { runtime?.retry(route.connectionId) },
            onAction = {},
            onBack = onBack,
            composer = runtime?.let {
                ThreadComposerPresentation(
                    draft = localDraft.text,
                    runtimeMode = localDraft.runtimeMode.toRuntimeMode(),
                    submitting = false,
                    interrupting = false,
                    modeChanging = false,
                    error = composerErrors[composerKey],
                    controlMessage = null,
                    focusRequest = 0,
                    showInterrupt = false,
                    attachments = localDraft.attachments,
                    editingOrigin = localDraft.editingOrigin,
                )
            },
            onDraftChange = { text ->
                localDraft = localDraft.copy(text = text)
                runtime?.saveComposerDraft(localDraft)
            },
            onRuntimeModeChange = { mode ->
                localDraft = localDraft.copy(runtimeMode = mode.wire)
                runtime?.saveComposerDraft(localDraft)
            },
            onImagesSelected = { sources -> runtime?.addComposerImages(composerKey, sources) },
            onRemoveImage = { attachmentId ->
                runtime?.removeComposerImage(composerKey, attachmentId)
            },
            onSend = { runtime?.submitSavedComposerDraft(composerKey) },
            queuedTurns = queuedTurns,
            onOutboxAction = { origin, action ->
                runtime?.performOutboxAction(composerKey, origin, action)
            },
        )
        return
    }

    ConnectedThreadRoute(
        route = route,
        runtime = runtime,
        lease = lease,
        savedDraft = savedDraft,
        composerError = composerErrors[composerKey],
        queuedTurns = queuedTurns,
        onBack = onBack,
    )
}

@Composable
private fun ConnectedThreadRoute(
    route: AppRoute.Thread,
    runtime: RootNavigationRuntime,
    lease: ReadyClientLease,
    savedDraft: ComposerDraft?,
    composerError: String?,
    queuedTurns: List<QueuedTurn>,
    onBack: () -> Unit,
) {
    val composerKey = remember(route.connectionId, route.threadId) {
        ComposerDraftKey(route.connectionId, route.threadId)
    }
    val coroutineScope = rememberCoroutineScope()
    val events = remember(runtime, lease.scope) { runtime.eventsFor(lease.scope) }
    val coordinator = remember(runtime, route.connectionId, route.threadId, lease.scope) {
        val bridge = ProtocolRuntimeEventBridge(
            scope = coroutineScope,
            expectedScope = lease.scope,
            events = events,
            isLeaseCurrent = { runtime.lease(route.connectionId)?.scope == lease.scope },
        )
        val commands = SwitchboardThreadSessionRemote(
            client = lease.client,
            scope = lease.scope.toThreadEventScope(),
        )
        ThreadSessionCoordinator(
            scope = lease.scope.toThreadEventScope(),
            threadId = route.threadId,
            initialCached = runtime.cachedThread(route.connectionId, route.threadId),
            remote = ProtocolHubThreadSessionRemote(commands, bridge),
            enqueue = object : ThreadEnqueuePort {
                override fun enqueue(draft: app.switchboard.mobile.domain.outbox.OutgoingTurnDraft) =
                    runtime.enqueue(draft)

                override fun replace(
                    origin: String,
                    draft: app.switchboard.mobile.domain.outbox.OutgoingTurnDraft,
                ) = runtime.replaceQueued(origin, draft)
            },
            clock = ThreadSessionClock(System::currentTimeMillis),
            initialComposer = savedDraft,
            composerPersistence = object : ThreadComposerPersistence {
                override fun save(draft: ComposerDraft) = runtime.saveComposerDraft(draft)

                override fun clear(key: ComposerDraftKey): Boolean =
                    runtime.clearComposerDraftBlocking(key)
            },
        )
    }

    LaunchedEffect(coordinator, savedDraft) {
        coordinator.installComposerDraft(savedDraft)
    }

    LaunchedEffect(coordinator, events, lease.scope) {
        events.collect { event ->
            if (
                event is ProtocolHubEvent.ReplayGap &&
                event.scope == lease.scope &&
                runtime.lease(route.connectionId)?.scope == lease.scope
            ) {
                coordinator.onReplayGap(lease.scope.toThreadEventScope())
            }
        }
    }

    ThreadSessionScreen(
        coordinator = coordinator,
        threadId = route.threadId,
        title = route.title,
        backendLabel = route.connectionLabel,
        onBack = onBack,
        onImagesSelected = { sources -> runtime.addComposerImages(composerKey, sources) },
        onRemoveImage = { attachmentId -> runtime.removeComposerImage(composerKey, attachmentId) },
        queuedTurns = queuedTurns,
        onOutboxAction = { origin, action ->
            runtime.performOutboxAction(composerKey, origin, action)
        },
        composerError = composerError,
    )
}

private fun RootNavigationRuntime.performOutboxAction(
    key: ComposerDraftKey,
    origin: String,
    action: OutboxUiAction,
) {
    when (action) {
        OutboxUiAction.Retry -> retryQueued(origin)
        OutboxUiAction.Edit -> beginQueuedEdit(key, origin)
        OutboxUiAction.Dismiss -> dismissQueued(origin)
    }
}

private fun String.toRuntimeMode(): RuntimeMode =
    RuntimeMode.entries.firstOrNull { it.wire == this } ?: RuntimeMode.Sandbox

private fun ConnectionsLoadState.labelFor(connectionId: String): String =
    (this as? ConnectionsLoadState.Ready)
        ?.connections
        ?.firstOrNull { it.id == connectionId }
        ?.label
        ?: connectionId

private fun <T> LeaseFallback.toBrowseLoadState(): BrowseLoadState<T> = when (this) {
    LeaseFallback.Loading -> BrowseLoadState.Loading()
    is LeaseFallback.Retryable -> BrowseLoadState.Failed(message)
}

private fun emptyOfflineSnapshot() = OfflineSnapshot(
    connections = emptyList(),
    credentialRefs = emptyList(),
    nativeCredentialRefs = emptyList(),
    preferences = emptyList(),
    threadPreferences = emptyList(),
    collapsedWorkspaces = emptyList(),
    cachedThreads = emptyList(),
    feedRows = emptyList(),
    outbox = emptyList(),
    outboxAttachments = emptyList(),
    replayStates = emptyList(),
    pendingControlActions = emptyList(),
    quarantinedRecords = emptyList(),
)
