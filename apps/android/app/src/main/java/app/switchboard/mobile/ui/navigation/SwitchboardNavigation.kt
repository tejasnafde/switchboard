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
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.SwitchboardBrowseRemote
import app.switchboard.mobile.data.thread.SwitchboardThreadSessionRemote
import app.switchboard.mobile.data.thread.ThreadEnqueuePort
import app.switchboard.mobile.data.thread.ThreadSessionClock
import app.switchboard.mobile.data.thread.ThreadSessionCoordinator
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
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
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.pairing.PairingScreen
import app.switchboard.mobile.ui.thread.ThreadLoadState
import app.switchboard.mobile.ui.thread.ThreadScreen
import app.switchboard.mobile.ui.thread.ThreadSessionScreen
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect

private val EmptyRuntimeStatuses = MutableStateFlow<Map<String, ConnectionRuntimeState>>(emptyMap())

@Composable
fun SwitchboardNavigation(
    connectionsState: ConnectionsLoadState,
    buildStamp: String,
    resolveEditForm: (String) -> PairingForm?,
    onConnectionIntent: (ConnectionIntent) -> Unit,
    onPairingIntent: suspend (PairingSaveIntent) -> PairingSaveResult,
    onQrUnavailable: () -> Unit,
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
            onQrUnavailable = onQrUnavailable,
        )

        is AppRoute.Pair -> PairingScreen(
            editConnectionId = route.editConnectionId,
            initialForm = route.editConnectionId?.let(resolveEditForm),
            onBack = ::navigateBack,
            onSave = onPairingIntent,
            onSaved = ::navigateBack,
            onQrUnavailable = onQrUnavailable,
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
            onBack = onBack,
        )
        return
    }

    ConnectedBrowseRoute(
        route = route,
        browseRoute = browseRoute,
        snapshot = snapshot,
        lease = lease,
        onProjectTap = onProjectTap,
        onSessionTap = onSessionTap,
        onBack = onBack,
    )
}

@Composable
private fun ConnectedBrowseRoute(
    route: AppRoute.Browse,
    browseRoute: BrowseRoute,
    snapshot: OfflineSnapshot,
    lease: ReadyClientLease,
    onProjectTap: (Project) -> Unit,
    onSessionTap: (Conversation) -> Unit,
    onBack: () -> Unit,
) {
    val coordinator = remember(route.connectionId, route.connectionLabel, lease.scope) {
        BrowseCoordinator(
            connectionId = route.connectionId,
            connectionLabel = route.connectionLabel,
            offlineSnapshot = snapshot,
            remote = SwitchboardBrowseRemote(lease.client),
            expectedGeneration = lease.scope.generation,
        )
    }
    val state by coordinator.state.collectAsState()

    LaunchedEffect(coordinator) {
        coordinator.refreshProjects()
    }
    LaunchedEffect(coordinator, snapshot) {
        coordinator.updateOfflineSnapshot(snapshot)
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
        onBack = onBack,
    )
}

@Composable
private fun ThreadRouteHost(
    route: AppRoute.Thread,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    onBack: () -> Unit,
) {
    val lease = remember(runtime, route.connectionId, status) {
        runtime?.lease(route.connectionId)
    }
    if (lease == null || runtime == null) {
        val cached = runtime?.cachedThread(route.connectionId, route.threadId)
        val load = when (val fallback = RootNavigationPolicy.fallback(status)) {
            LeaseFallback.Loading -> ThreadLoadState.Loading(cached)
            is LeaseFallback.Retryable -> ThreadLoadState.Failed(fallback.message, cached)
        }
        ThreadScreen(
            threadId = route.threadId,
            title = route.title,
            backendLabel = route.connectionLabel,
            loadState = load,
            onRetry = { runtime?.retry(route.connectionId) },
            onAction = {},
            onBack = onBack,
        )
        return
    }

    ConnectedThreadRoute(route, runtime, lease, onBack)
}

@Composable
private fun ConnectedThreadRoute(
    route: AppRoute.Thread,
    runtime: RootNavigationRuntime,
    lease: ReadyClientLease,
    onBack: () -> Unit,
) {
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
            enqueue = ThreadEnqueuePort(runtime::enqueue),
            clock = ThreadSessionClock(System::currentTimeMillis),
        )
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
    )
}

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
