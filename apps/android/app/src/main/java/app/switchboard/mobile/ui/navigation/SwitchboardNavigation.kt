package app.switchboard.mobile.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
import app.switchboard.mobile.data.remote.SwitchboardNewSessionWorktreeCreationPort
import app.switchboard.mobile.data.remote.UnavailableNewSessionWorktreeCreationPort
import app.switchboard.mobile.data.remote.WorktreeCreationIdSource
import app.switchboard.mobile.data.thread.SwitchboardThreadSessionRemote
import app.switchboard.mobile.data.thread.CachedThreadStateMapper
import app.switchboard.mobile.data.thread.ThreadEnqueuePort
import app.switchboard.mobile.data.thread.ThreadComposerPersistence
import app.switchboard.mobile.data.thread.ThreadSessionClock
import app.switchboard.mobile.data.thread.ThreadSessionCoordinator
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.composer.OutboxUiAction
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.remote.ChatMessage
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.ForkConversationOutcome
import app.switchboard.mobile.domain.remote.ForkDirtySource
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.notification.PendingNotificationRoute
import app.switchboard.mobile.platform.deeplink.PendingAppDeepLink
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleCredentialImportResult
import app.switchboard.mobile.platform.google.GoogleSignOutResult
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
import app.switchboard.mobile.ui.google.GoogleAccountScreen
import app.switchboard.mobile.ui.home.HomeMachineSnapshot
import app.switchboard.mobile.ui.home.HomeProjectRefreshCoordinator
import app.switchboard.mobile.ui.home.HomePresenter
import app.switchboard.mobile.ui.home.HomeRecentRow
import app.switchboard.mobile.ui.home.HomeScreen
import app.switchboard.mobile.ui.browse.BrowseCachedActivity
import app.switchboard.mobile.ui.newsession.NewSessionScreen
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.pairing.PairingScreen
import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.domain.iap.IapTargetSelection
import app.switchboard.mobile.ui.search.MessageSearchRouteHost
import app.switchboard.mobile.ui.search.MessageSearchScreen
import app.switchboard.mobile.data.remote.MessageSearchState
import app.switchboard.mobile.data.remote.GitContextCoordinator
import app.switchboard.mobile.data.remote.ConversationForkWire
import app.switchboard.mobile.ui.thread.ThreadLoadState
import app.switchboard.mobile.ui.thread.ThreadScreen
import app.switchboard.mobile.ui.thread.ThreadComposerPresentation
import app.switchboard.mobile.ui.thread.ThreadSessionScreen
import app.switchboard.mobile.ui.thread.GitContextPresenter
import app.switchboard.mobile.ui.settings.SettingsPresenter
import app.switchboard.mobile.ui.settings.SettingsScreen
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateState
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
    googleAccountPresentation: GoogleAccountPresentation = GoogleAccountPresentation.SignedOut,
    onGoogleImportCredentials: suspend (String) -> GoogleCredentialImportResult = {
        GoogleCredentialImportResult.PersistenceFailed
    },
    onGoogleSignOut: suspend () -> GoogleSignOutResult = {
        GoogleSignOutResult.AlreadySignedOut
    },
    offlineSnapshot: OfflineSnapshot? = null,
    runtime: RootNavigationRuntime? = null,
    pendingNotificationRoute: PendingNotificationRoute? = null,
    notificationRouteWake: Long = 0,
    onNotificationRouteAccepted: (PendingNotificationRoute) -> Unit = {},
    pendingAppDeepLink: PendingAppDeepLink? = null,
    onAppDeepLinkAccepted: (PendingAppDeepLink) -> Unit = {},
    updateState: UpdateState = UpdateState.Idle,
    updatesEnabled: Boolean = false,
    onUpdateAction: (UpdateAction) -> Unit = {},
) {
    var navigationState by rememberSaveable { mutableStateOf(NavigationState.root()) }
    val runtimeStatuses by (runtime?.statuses ?: EmptyRuntimeStatuses).collectAsState()
    val visibleConnections = remember(connectionsState, runtimeStatuses) {
        RuntimeConnectionsMapper.overlay(connectionsState, runtimeStatuses)
    }

    LaunchedEffect(pendingAppDeepLink?.requestId) {
        val pending = pendingAppDeepLink ?: return@LaunchedEffect
        navigationState = AppDeepLinkNavigationResolver.resolve(pending)
        onAppDeepLinkAccepted(pending)
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

    Box(
        modifier = Modifier
            .fillMaxSize()
            .edgeSwipeBack(
                enabled = navigationState.canGoBack,
                onBack = ::navigateBack,
            ),
    ) {
        when (val route = navigationState.current) {
            AppRoute.Connections -> HomeRouteHost(
                connectionsState = visibleConnections,
                snapshot = offlineSnapshot ?: emptyOfflineSnapshot(),
                runtime = runtime,
                googleAccountPresentation = googleAccountPresentation,
                onGoogleAccount = {
                    navigationState = navigationState.push(AppRoute.GoogleAccount)
                },
                onSettings = {
                    navigationState = navigationState.push(AppRoute.Settings)
                },
                onAdd = { navigationState = navigationState.push(AppRoute.Pair()) },
                onManageMachines = {
                    navigationState = navigationState.push(AppRoute.ManageConnections)
                },
                onMachine = { connectionId ->
                    navigationState = navigationState.push(
                        AppRoute.Browse(
                            connectionId = connectionId,
                            connectionLabel = visibleConnections.labelFor(connectionId),
                        ),
                    )
                },
                onRecent = { recent ->
                    navigationState = navigationState.push(
                        AppRoute.Thread(
                            connectionId = recent.connectionId,
                            connectionLabel = recent.connectionLabel,
                            threadId = recent.threadId,
                            projectPath = recent.projectPath,
                            worktreePath = recent.worktreePath,
                            title = recent.title,
                            provider = recent.provider,
                        ),
                    )
                },
                onRetry = { onConnectionIntent(ConnectionIntent.Retry) },
            )

            AppRoute.ManageConnections -> ConnectionsScreen(
                presentation = ConnectionsPresenter.present(visibleConnections),
                buildStamp = buildStamp,
                onAdd = { navigationState = navigationState.push(AppRoute.Pair()) },
                onManualAdd = {
                    navigationState = navigationState.push(AppRoute.Pair(startManual = true))
                },
                onEdit = { connectionId ->
                    navigationState = navigationState.push(AppRoute.Pair(connectionId))
                },
                googleAccount = googleAccountPresentation,
                onGoogleAccount = {
                    navigationState = navigationState.push(AppRoute.GoogleAccount)
                },
                onBack = ::navigateBack,
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

            AppRoute.Settings -> SettingsScreen(
                presentation = SettingsPresenter.present(
                    account = googleAccountPresentation,
                    connections = visibleConnections,
                    updateState = updateState,
                    versionName = buildStamp.removePrefix("v").substringBefore(" ·"),
                    updatesEnabled = updatesEnabled,
                ),
                onBack = ::navigateBack,
                onGoogleAccount = {
                    navigationState = navigationState.push(AppRoute.GoogleAccount)
                },
                onManageMachines = {
                    navigationState = navigationState.push(AppRoute.ManageConnections)
                },
                onUpdateAction = onUpdateAction,
            )

            is AppRoute.Pair -> PairingScreen(
                editConnectionId = route.editConnectionId,
                startManual = route.startManual,
                initialForm = route.editConnectionId?.let(resolveEditForm),
                onBack = ::navigateBack,
                onSave = onPairingIntent,
                onSaved = ::navigateBack,
                googleAccountReady = GoogleAccountNavigationPolicy.isReady(
                    googleAccountPresentation,
                ),
                onGoogleAccountRequired = {
                    navigationState = navigationState.push(AppRoute.GoogleAccount)
                },
                discoverIapTargets = {
                    val ready = visibleConnections as? ConnectionsLoadState.Ready
                    val ids = ready?.connections.orEmpty().map { it.id }
                    val saved = ready?.connections.orEmpty().mapNotNull { connection ->
                        val form = resolveEditForm(connection.id)
                        if (form?.kind != app.switchboard.mobile.ui.pairing.PairingConnectionKind.IAP) {
                            null
                        } else {
                            val port = form.port.toIntOrNull() ?: return@mapNotNull null
                            IapTarget(form.project, form.zone, form.instance, port)
                        }
                    }
                    runtime?.discoverIapTargets(ids, saved)
                        ?: IapTargetSelection(emptyList(), 0, 0)
                },
            )

            AppRoute.GoogleAccount -> GoogleAccountRouteHost(
                accountPresentation = googleAccountPresentation,
                onImportCredentials = onGoogleImportCredentials,
                onSignOut = onGoogleSignOut,
                onBack = ::navigateBack,
            )

            is AppRoute.MessageSearch -> {
                val lease = runtime?.lease(route.connectionId)
                if (lease == null) {
                    MessageSearchScreen(
                        connectionLabel = route.connectionLabel,
                        state = MessageSearchState(
                            error = RootNavigationPolicy.fallback(
                                runtimeStatuses[route.connectionId],
                            ).message(),
                        ),
                        onQueryChange = {},
                        onRetry = { runtime?.retry(route.connectionId) },
                        onBack = ::navigateBack,
                        onOpenResult = {},
                    )
                } else {
                    MessageSearchRouteHost(
                        connectionLabel = route.connectionLabel,
                        lease = lease,
                        onBack = ::navigateBack,
                        onOpenResult = { result ->
                            navigationState = navigationState.push(
                                AppRoute.Thread(
                                    connectionId = route.connectionId,
                                    connectionLabel = route.connectionLabel,
                                    threadId = result.conversationId,
                                    projectPath = result.projectPath,
                                    worktreePath = result.worktreePath,
                                    title = result.conversationTitle,
                                    provider = result.agentType,
                                ),
                            )
                        },
                    )
                }
            }

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
                            worktreePath = conversation.worktreePath,
                            title = conversation.title,
                            provider = conversation.agentType,
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
                onMessageSearch = {
                    navigationState = navigationState.push(
                        AppRoute.MessageSearch(
                            connectionId = route.connectionId,
                            connectionLabel = route.connectionLabel,
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
                offlineSnapshot = offlineSnapshot,
                onBack = ::navigateBack,
                onForked = { fork ->
                    navigationState = navigationState.push(
                        AppRoute.Thread(
                            connectionId = route.connectionId,
                            connectionLabel = route.connectionLabel,
                            threadId = fork.id,
                            projectPath = fork.projectPath,
                            worktreePath = fork.worktreePath,
                            title = fork.title,
                            provider = fork.agentType,
                        ),
                    )
                },
            )
        }
    }
}

@Composable
private fun HomeRouteHost(
    connectionsState: ConnectionsLoadState,
    snapshot: OfflineSnapshot,
    runtime: RootNavigationRuntime?,
    googleAccountPresentation: GoogleAccountPresentation,
    onGoogleAccount: () -> Unit,
    onSettings: () -> Unit,
    onAdd: () -> Unit,
    onManageMachines: () -> Unit,
    onMachine: (String) -> Unit,
    onRecent: (HomeRecentRow) -> Unit,
    onRetry: () -> Unit,
) {
    var recentLimit by rememberSaveable { mutableStateOf(HOME_RECENT_PAGE_SIZE) }
    val connectionItems = (connectionsState as? ConnectionsLoadState.Ready)
        ?.connections
        .orEmpty()
    val snapshotStore = remember(runtime, snapshot) {
        runtime?.browseSnapshotStore(snapshot)
    }
    val machineSnapshots = connectionItems.map { connection ->
        val lease = runtime?.lease(connection.id)
        key(connection.id, lease?.scope) {
            val liveActivity = if (runtime != null && lease != null) {
                val activity by remember(runtime, lease.scope) {
                    runtime.browseActivity(lease.scope)
                }.collectAsState()
                activity
            } else {
                emptyMap()
            }
            val cachedActivity = remember(snapshot, connection.id) {
                BrowseCachedActivity.from(snapshot, connection.id)
            }
            val projects = if (lease != null && snapshotStore != null) {
                val refreshCoordinator = remember(
                    connection.id,
                    connection.label,
                    lease.scope,
                    snapshotStore,
                ) {
                    HomeProjectRefreshCoordinator(
                        connectionId = connection.id,
                        connectionLabel = connection.label,
                        offlineSnapshot = snapshot,
                        remote = SwitchboardBrowseRemote(lease.client),
                        expectedGeneration = lease.scope.generation,
                        snapshotStore = snapshotStore,
                    )
                }
                DisposableEffect(refreshCoordinator) {
                    refreshCoordinator.start()
                    onDispose(refreshCoordinator::close)
                }
                val refreshed by refreshCoordinator.state.collectAsState()
                refreshed.projects.homeProjects()
            } else {
                remember(snapshotStore, connection.id) {
                    snapshotStore?.load(connection.id)?.projects.orEmpty()
                }
            }
            val threadStates = projects
                .asSequence()
                .flatMap { it.sessions.asSequence() }
                .mapNotNull { session ->
                    runtime?.cachedThread(connection.id, session.id)?.let { session.id to it }
                }
                .toMap()
            HomeMachineSnapshot(
                connectionId = connection.id,
                connectionLabel = connection.label,
                projects = projects,
                threadStates = threadStates,
                activity = cachedActivity + liveActivity,
            )
        }
    }
    val recents = remember(machineSnapshots, recentLimit) {
        HomePresenter.recents(machineSnapshots, recentLimit)
    }
    HomeScreen(
        recents = recents,
        machines = ConnectionsPresenter.present(connectionsState),
        googleAccount = googleAccountPresentation,
        onRecent = onRecent,
        onMachine = onMachine,
        onShowMore = {
            recentLimit = (recentLimit + HOME_RECENT_PAGE_SIZE).coerceAtMost(recents.total)
        },
        onManageMachines = onManageMachines,
        onAddMachine = onAdd,
        onGoogleAccount = onGoogleAccount,
        onSettings = onSettings,
        onRetryMachines = onRetry,
    )
}

private fun BrowseLoadState<BrowseProjectRecord>.homeProjects(): List<Project> = when (this) {
    is BrowseLoadState.Loading -> cached.map(BrowseProjectRecord::project)
    is BrowseLoadState.Ready -> items.map(BrowseProjectRecord::project)
    is BrowseLoadState.Failed -> cached.map(BrowseProjectRecord::project)
}

@Composable
private fun GoogleAccountRouteHost(
    accountPresentation: GoogleAccountPresentation,
    onImportCredentials: suspend (String) -> GoogleCredentialImportResult,
    onSignOut: suspend () -> GoogleSignOutResult,
    onBack: () -> Unit,
) {
    var showQrUnavailableNotice by rememberSaveable { mutableStateOf(false) }
    GoogleAccountScreen(
        accountPresentation = accountPresentation,
        onBack = onBack,
        onScanQr = { showQrUnavailableNotice = true },
        onImportCredentials = onImportCredentials,
        onSignOut = onSignOut,
        informationalNotice = if (showQrUnavailableNotice) {
            GoogleAccountNavigationPolicy.QrUnavailableNotice
        } else {
            null
        },
    )
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
    onMessageSearch: () -> Unit,
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
            onMessageSearch = onMessageSearch,
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
        onMessageSearch = onMessageSearch,
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
    onMessageSearch: () -> Unit,
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
        onMessageSearch = onMessageSearch,
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
            onWorkspace = {},
            onFirstMessage = {},
            onStart = { runtime?.retry(route.connectionId) },
            onReconcileWorktree = {},
            onRetryWorktree = {},
            onRunWorktreeSetup = {},
            onSkipWorktreeSetup = {},
            onRetainWorktree = {},
            onRemoveWorktree = {},
            onStartInProject = {},
            onCancelWorktree = {},
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
            worktrees = if ("worktree_creation_v1" in lease.capabilities) {
                SwitchboardNewSessionWorktreeCreationPort(lease.client)
            } else {
                UnavailableNewSessionWorktreeCreationPort(route.connectionId, lease.scope.generation)
            },
            worktreeStore = runtime.worktreeCreations,
            creationIds = WorktreeCreationIdSource { java.util.UUID.randomUUID().toString() },
            worktreeAvailable = "worktree_creation_v1" in lease.capabilities,
        )
    }
    val state by coordinator.state.collectAsState()
    DisposableEffect(coordinator) {
        onDispose(coordinator::close)
    }
    LaunchedEffect(coordinator) { coordinator.load() }
    NewSessionScreen(
        state = state,
        onBack = onBack,
        onProvider = coordinator::selectProvider,
        onRuntimeMode = coordinator::selectRuntimeMode,
        onInstance = coordinator::selectInstance,
        onModel = coordinator::selectModel,
        onWorkspace = coordinator::selectWorkspace,
        onFirstMessage = coordinator::updateFirstMessage,
        onStart = coordinator::submit,
        onReconcileWorktree = coordinator::reconcileWorktreeCreation,
        onRetryWorktree = coordinator::retryWorktreeCreation,
        onRunWorktreeSetup = { coordinator.chooseWorktreeSetup(run = true) },
        onSkipWorktreeSetup = { coordinator.chooseWorktreeSetup(run = false) },
        onRetainWorktree = coordinator::retainWorktree,
        onRemoveWorktree = coordinator::removeWorktree,
        onStartInProject = coordinator::useParentCheckout,
        onCancelWorktree = coordinator::cancelWorktreeCreation,
    )
}

@Composable
private fun ThreadRouteHost(
    route: AppRoute.Thread,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    offlineSnapshot: OfflineSnapshot?,
    onBack: () -> Unit,
    onForked: (app.switchboard.mobile.domain.remote.ForkConversationState) -> Unit,
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
            ?: offlineSnapshot?.let {
                CachedThreadStateMapper.from(it, route.connectionId, route.threadId)
            }
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
        offlineSnapshot = offlineSnapshot,
        savedDraft = savedDraft,
        composerError = composerErrors[composerKey],
        queuedTurns = queuedTurns,
        onBack = onBack,
        onForked = onForked,
    )
}

@Composable
private fun ConnectedThreadRoute(
    route: AppRoute.Thread,
    runtime: RootNavigationRuntime,
    lease: ReadyClientLease,
    offlineSnapshot: OfflineSnapshot?,
    savedDraft: ComposerDraft?,
    composerError: String?,
    queuedTurns: List<QueuedTurn>,
    onBack: () -> Unit,
    onForked: (app.switchboard.mobile.domain.remote.ForkConversationState) -> Unit,
) {
    val composerKey = remember(route.connectionId, route.threadId) {
        ComposerDraftKey(route.connectionId, route.threadId)
    }
    val coroutineScope = rememberCoroutineScope()
    var forkError by remember(route.threadId) { mutableStateOf<String?>(null) }
    var pendingDirtyFork by remember(route.threadId) { mutableStateOf<PendingAndroidFork?>(null) }
    var forkAttemptKey by rememberSaveable(route.threadId) { mutableStateOf("") }
    var forkAttemptId by rememberSaveable(route.threadId) { mutableStateOf("") }
    fun requestIdFor(messageId: String, withWorktree: Boolean): String {
        val key = "$messageId:${if (withWorktree) "worktree" else "shared"}"
        if (forkAttemptKey != key || forkAttemptId.isBlank()) {
            forkAttemptKey = key
            forkAttemptId = java.util.UUID.randomUUID().toString()
        }
        return forkAttemptId
    }
    fun completeFork(conversation: app.switchboard.mobile.domain.remote.ForkConversationState) {
        forkAttemptKey = ""
        forkAttemptId = ""
        onForked(conversation)
    }
    val events = remember(runtime, lease.scope) { runtime.eventsFor(lease.scope) }
    val coordinator = remember(
        runtime,
        route.connectionId,
        route.threadId,
        route.projectPath,
        route.worktreePath,
        route.provider,
        lease.scope,
    ) {
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
            initialCached = runtime.cachedThread(route.connectionId, route.threadId)
                ?: offlineSnapshot?.let {
                    CachedThreadStateMapper.from(it, route.connectionId, route.threadId)
                },
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
            snapshotStore = runtime.threadSnapshots,
            projectPath = route.projectPath,
            worktreePath = route.worktreePath,
            providerHint = route.provider,
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

    val viewingLeaseLifecycle = remember(runtime, lease.scope, route.threadId) {
        ThreadViewingLeaseLifecycle(
            expectedScope = lease.scope,
            threadId = route.threadId,
            currentScope = { runtime.lease(route.connectionId)?.scope },
            begin = runtime::beginViewing,
        )
    }
    val viewingRenewalRegistration = remember(runtime) {
        { callback: () -> Unit -> runtime.registerViewingLeaseRenewal(callback) }
    }
    val gitContextCoordinator = remember(
        lease.scope,
        route.projectPath,
        route.worktreePath,
        lease.client,
    ) {
        GitContextCoordinator(
            connectionId = route.connectionId,
            expectedGeneration = lease.scope.generation,
            cwd = route.worktreePath ?: route.projectPath,
            branchHint = null,
            remote = lease.client,
        )
    }
    val gitContextState by gitContextCoordinator.state.collectAsState()
    LaunchedEffect(gitContextCoordinator) { gitContextCoordinator.refresh() }
    DisposableEffect(gitContextCoordinator) {
        onDispose(gitContextCoordinator::close)
    }
    val gitContext = remember(route.projectPath, route.worktreePath, gitContextState) {
        GitContextPresenter.present(
            projectPath = route.projectPath,
            worktreePath = route.worktreePath,
            state = gitContextState,
        )
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
        gitContext = gitContext,
        onRefreshGitContext = gitContextCoordinator::refresh,
        viewingLeaseLifecycle = viewingLeaseLifecycle,
        registerViewingLeaseRenewal = viewingRenewalRegistration,
        onFork = { messageId, withWorktree ->
            lease.client.loadSession(route.threadId) { loadedResponse ->
                when (val loaded = loadedResponse.outcome) {
                    is RemoteOutcome.Failure -> forkError = loaded.message
                    is RemoteOutcome.Success -> {
                        val message = loaded.value.messages.singleOrNull { it.id == messageId }
                        if (message == null) {
                            forkError = "The selected message is no longer a unique canonical fork anchor."
                        } else {
                            val request = ConversationForkWire.request(
                                requestIdFor(messageId, withWorktree),
                                route.threadId,
                                message,
                                withWorktree,
                                System.currentTimeMillis(),
                            )
                            lease.client.getConversationFork(request) { priorResponse ->
                                when (val prior = priorResponse.outcome) {
                                    is RemoteOutcome.Failure -> forkError = prior.message
                                    is RemoteOutcome.Success -> {
                                        fun accept(outcome: ForkConversationOutcome) {
                                            when (outcome) {
                                                is ForkConversationOutcome.Completed -> completeFork(outcome.result.conversation)
                                                is ForkConversationOutcome.ConfirmationRequired -> {
                                                    pendingDirtyFork = PendingAndroidFork(
                                                        message,
                                                        outcome.dirtySource,
                                                        request.requestId,
                                                    )
                                                }
                                                is ForkConversationOutcome.Failed -> forkError = outcome.failureMessage()
                                            }
                                        }
                                        if (prior.value != null) {
                                            accept(prior.value)
                                        } else {
                                            lease.client.forkConversation(request) { createdResponse ->
                                                when (val created = createdResponse.outcome) {
                                                    is RemoteOutcome.Failure -> forkError = created.message
                                                    is RemoteOutcome.Success -> accept(created.value)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    )
    pendingDirtyFork?.let { pending ->
        AlertDialog(
            onDismissRequest = { pendingDirtyFork = null },
            title = { Text("Uncommitted changes will not be copied") },
            text = { Text("The new worktree starts from ${pending.dirty.headSha.take(8)}. ${pending.dirty.omittedChangeSummary}") },
            dismissButton = { TextButton(onClick = { pendingDirtyFork = null }) { Text("Cancel") } },
            confirmButton = {
                TextButton(onClick = {
                    pendingDirtyFork = null
                    val confirmed = ConversationForkWire.request(
                        pending.requestId,
                        route.threadId,
                        pending.message,
                        true,
                        System.currentTimeMillis(),
                        pending.dirty,
                    )
                    lease.client.forkConversation(confirmed) { response ->
                        when (val result = response.outcome) {
                            is RemoteOutcome.Failure -> forkError = result.message
                            is RemoteOutcome.Success -> when (val outcome = result.value) {
                                is ForkConversationOutcome.Completed -> completeFork(outcome.result.conversation)
                                is ForkConversationOutcome.Failed -> forkError = outcome.failureMessage()
                                is ForkConversationOutcome.ConfirmationRequired -> {
                                    pendingDirtyFork = pending.copy(dirty = outcome.dirtySource)
                                }
                            }
                        }
                    }
                }) { Text("Continue from HEAD") }
            },
        )
    }
    forkError?.let { message ->
        AlertDialog(
            onDismissRequest = { forkError = null },
            title = { Text("Fork failed") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { forkError = null }) { Text("OK") } },
        )
    }
}

private data class PendingAndroidFork(
    val message: ChatMessage,
    val dirty: ForkDirtySource,
    val requestId: String,
)

private fun ForkConversationOutcome.Failed.failureMessage(): String = buildString {
    append(message)
    retainedPath?.let { append(" Retained worktree: $it") }
    retainedBranch?.let { append(" ($it)") }
}

private fun RootNavigationRuntime.performOutboxAction(
    key: ComposerDraftKey,
    origin: String,
    action: OutboxUiAction,
) {
    when (action) {
        OutboxUiAction.Retry -> retryQueued(origin)
        OutboxUiAction.Abandon -> abandonQueued(origin)
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

private fun LeaseFallback.message(): String = when (this) {
    LeaseFallback.Loading -> "Connecting to machine"
    is LeaseFallback.Retryable -> message
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

private const val HOME_RECENT_PAGE_SIZE = 5
