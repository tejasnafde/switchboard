package app.switchboard.mobile.runtime

import android.app.Application
import app.switchboard.mobile.data.connection.ConnectionFleet
import app.switchboard.mobile.data.connection.DeviceConnectionFleetTargetResolver
import app.switchboard.mobile.data.connection.NativeConnectionRepository
import app.switchboard.mobile.data.connection.NativeConnectionTargetResolver
import app.switchboard.mobile.data.connection.NativeSessionCredentialStore
import app.switchboard.mobile.data.connection.RepositoryConnectionFleetSnapshotSource
import app.switchboard.mobile.data.connection.RoomConnectionDatabase
import app.switchboard.mobile.data.local.SwitchboardDatabase
import app.switchboard.mobile.data.local.AppPreferenceEntity
import app.switchboard.mobile.data.composer.ComposerDraftCoordinator
import app.switchboard.mobile.data.composer.RoomComposerDraftStore
import app.switchboard.mobile.data.outbox.OutboxCapabilityLookup
import app.switchboard.mobile.data.outbox.OutboxClientLookup
import app.switchboard.mobile.data.outbox.OutboxClock
import app.switchboard.mobile.data.outbox.OutboxConnectionAvailability
import app.switchboard.mobile.data.outbox.OutboxIdSource
import app.switchboard.mobile.data.outbox.OutboxObserver
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.data.outbox.RoomOutboxStore
import app.switchboard.mobile.data.remote.ReadyClientRegistry
import app.switchboard.mobile.data.remote.RoomBrowseSnapshotStore
import app.switchboard.mobile.data.remote.ReadyEndpointLookup
import app.switchboard.mobile.data.thread.RoomThreadSnapshotStore
import app.switchboard.mobile.domain.push.ExpoPushProjectIdentity
import app.switchboard.mobile.domain.push.PushRegistrationCoordinator
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.connection.ConnectionStatus
import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.platform.migration.DialGate
import app.switchboard.mobile.platform.google.VerifiedGoogleCredentialStore
import app.switchboard.mobile.platform.google.OkHttpGoogleRevokeTransport
import app.switchboard.mobile.platform.google.OkHttpGoogleTokenExchange
import app.switchboard.mobile.platform.iap.OkHttpIapRelaySocketFactory
import app.switchboard.mobile.platform.notification.AndroidAppVisibilityMonitor
import app.switchboard.mobile.platform.notification.AppVisibilityTracker
import app.switchboard.mobile.platform.notification.AppVisibilityTransition
import app.switchboard.mobile.platform.notification.AndroidNotificationPermissionController
import app.switchboard.mobile.platform.notification.AndroidNotificationRouteStorage
import app.switchboard.mobile.platform.notification.AndroidTurnCompletionNotifier
import app.switchboard.mobile.platform.notification.BackgroundTurnNotificationCoordinator
import app.switchboard.mobile.platform.notification.BackgroundTurnNotificationRuntime
import app.switchboard.mobile.platform.notification.NotificationRouteInbox
import app.switchboard.mobile.platform.notification.NotificationThreadMetadata
import app.switchboard.mobile.platform.network.AndroidConnectivityMonitor
import app.switchboard.mobile.platform.outbox.AndroidPrivateFilesAttachmentStager
import app.switchboard.mobile.platform.outbox.AndroidComposerAttachmentStager
import app.switchboard.mobile.platform.outbox.PrivateFileOutboxImageMaterializer
import app.switchboard.mobile.platform.protocol.AuthenticatedConnectionFleetCoordinatorFactory
import app.switchboard.mobile.platform.protocol.ExecutorTransportScheduler
import app.switchboard.mobile.platform.protocol.OkHttpWebSocketDialer
import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.platform.protocol.RoomResumeCursorStore
import app.switchboard.mobile.platform.push.AndroidFirebaseTokenSource
import app.switchboard.mobile.platform.push.AndroidPushTokenStore
import app.switchboard.mobile.platform.push.OkHttpExpoTokenExchange
import app.switchboard.mobile.platform.push.PushTokenRuntime
import app.switchboard.mobile.platform.push.RemoteClientPushBackend
import app.switchboard.mobile.platform.push.androidExpoInstallationIdentity
import app.switchboard.mobile.platform.startup.AndroidStartupRuntime
import app.switchboard.mobile.platform.startup.GoogleStartupState
import app.switchboard.mobile.platform.startup.StartupRuntimeState
import app.switchboard.mobile.platform.storage.AndroidNativeCredentialPlatform
import app.switchboard.mobile.platform.storage.VerifiedNativeCredentialStore
import app.switchboard.mobile.ui.browse.BrowseCollapsePreferences
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import app.switchboard.mobile.ui.browse.BrowseThreadActivityIndex
import app.switchboard.mobile.BuildConfig
import java.io.Closeable
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

class NativeAndroidRuntime private constructor(
    val database: SwitchboardDatabase,
    val connectionRepository: NativeConnectionRepository,
    val connectionFleet: ConnectionFleet,
    val readyClients: ReadyClientRegistry,
    val protocolEvents: ProtocolEventHub,
    val outbox: OutboxRuntime,
    val composer: DurableComposerRuntime,
    val startup: AndroidStartupRuntime,
    val googleCredentials: VerifiedGoogleCredentialStore,
    val googleAccount: GoogleAccountRuntime,
    val deviceIdentity: StableDeviceIdentity,
    val notificationRoutes: NotificationRouteInbox,
    val notificationPermissions: AndroidNotificationPermissionController,
    val viewingLeaseRenewals: ViewingLeaseRenewalHooks,
    val browseSnapshots: RoomBrowseSnapshotStore,
    val threadSnapshots: RoomThreadSnapshotStore,
    private val pushRegistration: PushRegistrationCoordinator,
    private val pushTokenRuntime: PushTokenRuntime,
    private val requestPushToken: () -> Unit,
    private val pushViewingRenewal: Closeable,
    private val scope: CoroutineScope,
    private val transportScheduler: ExecutorTransportScheduler,
    private val outboxScheduler: ExecutorTransportScheduler,
    private val retryScheduler: TransportOutboxRetryScheduler,
    private val httpClient: OkHttpClient,
    private val notificationRuntime: BackgroundTurnNotificationRuntime,
    private val visibilityMonitor: AndroidAppVisibilityMonitor,
    private val connectivityMonitor: AndroidConnectivityMonitor,
) : Closeable {
    val connectionStatuses: StateFlow<Map<String, ConnectionRuntimeState>> =
        connectionFleet.statuses

    private val coordinator = ApplicationRuntimeCoordinator(
        seedRepository = connectionRepository::seed,
        startupComposer = composer::hydrate,
        startupOutbox = outbox::onStartupReady,
        wakeOutbox = outbox::onFleetChanged,
    )
    private val startupCompositionObservation = startup.observe { state ->
        if (state is StartupRuntimeState.Ready) threadSnapshots.seed(state.offlineSnapshot)
        coordinator.onStartupState(state)
    }
    private val googleAccountObservation = startup.observeGoogle { googleAccount.refresh() }
    private val fleetObservation: Job = scope.launch {
        connectionFleet.statuses.collect { statuses ->
            coordinator.onFleetChanged()
            pushRegistration.onReady(readyPushBackends(statuses, readyClients))
        }
    }
    private val browseActivityIndex = BrowseThreadActivityIndex()
    private val browseActivityObservation: Job = scope.launch {
        protocolEvents.events.collect { event ->
            if (event is ProtocolHubEvent.Runtime) {
                browseActivityIndex.onEvent(event.scope, event.event)
            }
        }
    }
    private var closed = false

    fun start() {
        pushTokenRuntime.start()
        requestPushToken()
        startup.start()
    }

    fun observeStartup(observer: (StartupRuntimeState) -> Unit): Closeable = startup.observe(observer)

    fun observeGoogleStartup(observer: (GoogleStartupState) -> Unit): Closeable =
        startup.observeGoogle(observer)

    val isGoogleNetworkAllowed: Boolean
        get() = startup.isGoogleNetworkAllowed

    /** Continues across Activity recreation; the application owns both this scope and the Room write. */
    fun removeConnection(connectionId: String) {
        if (connectionId.isBlank()) return
        pushRegistration.beforeConnectionRemoved(connectionId)
        scope.launch { connectionFleet.remove(connectionId) }
    }

    fun onFcmToken(token: String) = pushTokenRuntime.onFcmToken(token)

    fun beginViewing(scope: TransportScope, threadId: String): Closeable =
        pushRegistration.beginViewing(scope, threadId)

    @Synchronized
    fun browseActivity(transportScope: TransportScope): StateFlow<Map<String, BrowseThreadActivity>> {
        browseActivityIndex.discardOtherGenerations(
            transportScope.connectionId,
            transportScope.generation,
        )
        return browseActivityIndex.state(transportScope)
    }

    fun saveCollapsedWorkspaceIds(connectionId: String, workspaceIds: Set<String>) {
        if (connectionId.isBlank()) return
        val encoded = BrowseCollapsePreferences.encode(workspaceIds)
        scope.launch {
            database.preferenceDao().upsertPreference(
                AppPreferenceEntity(BrowseCollapsePreferences.key(connectionId), encoded),
            )
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        startupCompositionObservation.close()
        googleAccountObservation.close()
        fleetObservation.cancel()
        pushViewingRenewal.close()
        pushTokenRuntime.close()
        connectivityMonitor.close()
        notificationRuntime.close()
        visibilityMonitor.close()
        connectionFleet.close()
        readyClients.clear()
        composer.close()
        retryScheduler.close()
        protocolEvents.close()
        startup.close()
        googleAccount.close()
        scope.cancel()
        transportScheduler.close()
        outboxScheduler.close()
        httpClient.dispatcher.executorService.shutdownNow()
        httpClient.connectionPool.evictAll()
        database.close()
    }

    companion object {
        fun create(application: Application): NativeAndroidRuntime {
            val applicationContext = application.applicationContext
            val database = SwitchboardDatabase.open(applicationContext)
            val credentialPlatform = AndroidNativeCredentialPlatform(applicationContext)
            val credentials = VerifiedNativeCredentialStore(credentialPlatform)
            val googleCredentials = VerifiedGoogleCredentialStore(credentialPlatform)
            val connectionDatabase = RoomConnectionDatabase(database)
            val repository = NativeConnectionRepository(connectionDatabase, credentials)
            val identity = StableDeviceIdentityProvider(
                SharedPreferencesDeviceIdentityStorage(applicationContext),
            ).get()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val browseSnapshots = RoomBrowseSnapshotStore(
                initial = emptyList(),
                dao = database.browseSnapshotDao(),
                writes = java.util.concurrent.Executor { command -> scope.launch { command.run() } },
            )
            val threadSnapshots = RoomThreadSnapshotStore(
                dao = database.cacheDao(),
                writes = java.util.concurrent.Executor { command -> scope.launch { command.run() } },
            )
            val transportScheduler = ExecutorTransportScheduler()
            val outboxScheduler = ExecutorTransportScheduler()
            val retryScheduler = TransportOutboxRetryScheduler(outboxScheduler)
            val protocolEvents = ProtocolEventHub(bufferCapacity = PROTOCOL_EVENT_BUFFER)
            val httpClient = OkHttpClient()
            val googleTokenExchange = OkHttpGoogleTokenExchange(
                httpClient,
                System::currentTimeMillis,
            )
            val googleAccount = GoogleAccountRuntime(
                store = googleCredentials,
                exchange = googleTokenExchange,
                revoke = OkHttpGoogleRevokeTransport(httpClient),
            )
            val pushRegistration = PushRegistrationCoordinator()
            val expoInstallationIdentity = androidExpoInstallationIdentity(applicationContext)
            val pushTokenRuntime = PushTokenRuntime(
                enabled = BuildConfig.REMOTE_PUSH_ENABLED,
                identity = ExpoPushProjectIdentity(
                    projectId = BuildConfig.EXPO_PROJECT_ID,
                    applicationId = BuildConfig.PUSH_APPLICATION_ID,
                ),
                installationId = expoInstallationIdentity::getOrCreate,
                store = AndroidPushTokenStore(applicationContext),
                exchange = OkHttpExpoTokenExchange(httpClient),
                publish = pushRegistration::onExpoToken,
            )
            val fleet = ConnectionFleet(
                scope = scope,
                snapshots = RepositoryConnectionFleetSnapshotSource(repository),
                targetResolver = DeviceConnectionFleetTargetResolver(
                    resolver = NativeConnectionTargetResolver(connectionDatabase, credentials),
                    deviceId = identity.deviceId,
                    deviceLabel = identity.deviceLabel,
                ),
                coordinatorFactory = AuthenticatedConnectionFleetCoordinatorFactory(
                    dialer = composeNativeLineDialer(
                        direct = OkHttpWebSocketDialer(httpClient),
                        googleCredentials = googleCredentials,
                        tokenExchange = googleTokenExchange,
                        relaySocketFactory = OkHttpIapRelaySocketFactory(httpClient),
                        scheduler = transportScheduler,
                        nowEpochMs = System::currentTimeMillis,
                    ),
                    scheduler = transportScheduler,
                    cursorStore = RoomResumeCursorStore(database),
                    credentialStore = NativeSessionCredentialStore(repository, credentials),
                    observer = protocolEvents,
                ),
                remover = { connectionId -> repository.remove(connectionId) },
            )
            val clients = ReadyClientRegistry(ReadyEndpointLookup(fleet::endpoint))
            val notificationRoutes = NotificationRouteInbox(
                AndroidNotificationRouteStorage(applicationContext),
            )
            val notificationPermissions = AndroidNotificationPermissionController(applicationContext)
            var visibilityTransition: (AppVisibilityTransition) -> Unit = {}
            val visibilityTracker = AppVisibilityTracker { transition -> visibilityTransition(transition) }
            val visibilityMonitor = AndroidAppVisibilityMonitor.install(application, visibilityTracker)
            val turnNotifier = AndroidTurnCompletionNotifier(applicationContext).also {
                it.ensureChannel()
            }
            val notificationRuntime = BackgroundTurnNotificationRuntime(
                scope = scope,
                events = protocolEvents,
                coordinator = BackgroundTurnNotificationCoordinator(
                    isForeground = { visibilityMonitor.tracker.isForeground },
                    currentScope = { connectionId -> fleet.endpoint(connectionId)?.scope },
                    metadata = { _, _ -> NotificationThreadMetadata() },
                    notifier = turnNotifier,
                ),
            ).also(BackgroundTurnNotificationRuntime::start)
            val outbox = OutboxRuntime(
                store = RoomOutboxStore(database.outboxDao()),
                attachmentStager = AndroidPrivateFilesAttachmentStager(applicationContext),
                imageMaterializer = PrivateFileOutboxImageMaterializer(),
                clients = OutboxClientLookup { connectionId -> clients.lease(connectionId)?.client },
                capabilities = OutboxCapabilityLookup { turn -> availability(clients, turn) },
                clock = OutboxClock(System::currentTimeMillis),
                scheduler = retryScheduler,
                ids = OutboxIdSource { UUID.randomUUID().toString() },
                observer = SilentOutboxObserver,
            )
            val composer = DurableComposerRuntime(
                coordinator = ComposerDraftCoordinator(
                    store = RoomComposerDraftStore(database.composerDraftDao()),
                    stager = AndroidComposerAttachmentStager(applicationContext),
                ),
                outbox = outbox,
            )
            val viewingLeaseRenewals = ViewingLeaseRenewalHooks()
            val pushViewingRenewal = viewingLeaseRenewals.register(
                pushRegistration::renewViewingLeases,
            )
            val lifecycleResilience = LifecycleResilienceCoordinator(
                clock = System::currentTimeMillis,
                onNetworkChanged = fleet::onNetworkChanged,
                onForegroundAction = fleet::onForeground,
                wakeOutbox = outbox::onFleetChanged,
                renewViewingLeases = viewingLeaseRenewals::renewAll,
            )
            visibilityTransition = { transition ->
                when (transition) {
                    AppVisibilityTransition.Foreground -> lifecycleResilience.onForeground()
                    AppVisibilityTransition.Background -> lifecycleResilience.onBackground()
                }
            }
            val connectivityMonitor = AndroidConnectivityMonitor.install(
                applicationContext,
                lifecycleResilience::onNetworkAvailability,
            )
            val startup = AndroidStartupRuntime.create(
                context = applicationContext,
                database = database,
                credentials = credentials,
                googleCredentials = googleCredentials,
                dialGate = DialGate(fleet::startupReady),
            )
            return NativeAndroidRuntime(
                database = database,
                connectionRepository = repository,
                connectionFleet = fleet,
                readyClients = clients,
                protocolEvents = protocolEvents,
                outbox = outbox,
                composer = composer,
                startup = startup,
                googleCredentials = googleCredentials,
                googleAccount = googleAccount,
                deviceIdentity = identity,
                notificationRoutes = notificationRoutes,
                notificationPermissions = notificationPermissions,
                viewingLeaseRenewals = viewingLeaseRenewals,
                browseSnapshots = browseSnapshots,
                threadSnapshots = threadSnapshots,
                pushRegistration = pushRegistration,
                pushTokenRuntime = pushTokenRuntime,
                requestPushToken = {
                    AndroidFirebaseTokenSource.requestCurrent(
                        applicationContext,
                        pushTokenRuntime::onFcmToken,
                    )
                },
                pushViewingRenewal = pushViewingRenewal,
                scope = scope,
                transportScheduler = transportScheduler,
                outboxScheduler = outboxScheduler,
                retryScheduler = retryScheduler,
                httpClient = httpClient,
                notificationRuntime = notificationRuntime,
                visibilityMonitor = visibilityMonitor,
                connectivityMonitor = connectivityMonitor,
            )
        }

        private fun availability(
            clients: ReadyClientRegistry,
            turn: QueuedTurn,
        ): OutboxConnectionAvailability? {
            val lease = clients.lease(turn.connectionId) ?: return null
            return OutboxConnectionAvailability(
                generation = lease.scope.generation,
                readiness = DeliveryReadiness.Ready,
                capabilities = lease.capabilities,
            )
        }

        private fun readyPushBackends(
            statuses: Map<String, ConnectionRuntimeState>,
            clients: ReadyClientRegistry,
        ): List<RemoteClientPushBackend> = statuses.mapNotNull { (connectionId, state) ->
            if (state.status != ConnectionStatus.Connected) return@mapNotNull null
            clients.lease(connectionId)?.let(::RemoteClientPushBackend)
        }

        private const val PROTOCOL_EVENT_BUFFER = 256
    }
}

private object SilentOutboxObserver : OutboxObserver {
    override fun onDurablyEnqueued(turn: QueuedTurn) = Unit

    override fun onAcknowledged(turn: QueuedTurn) = Unit

    override fun onTerminal(turn: QueuedTurn, reason: String) = Unit

    override fun onAmbiguous(turn: QueuedTurn, reason: String) = Unit

    override fun onStorageBlocked(turn: QueuedTurn, reason: String) = Unit

    override fun onHydrationFailure(reason: String) = Unit
}
