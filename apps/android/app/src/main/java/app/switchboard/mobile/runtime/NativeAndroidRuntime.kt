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
import app.switchboard.mobile.data.outbox.OutboxCapabilityLookup
import app.switchboard.mobile.data.outbox.OutboxClientLookup
import app.switchboard.mobile.data.outbox.OutboxClock
import app.switchboard.mobile.data.outbox.OutboxConnectionAvailability
import app.switchboard.mobile.data.outbox.OutboxIdSource
import app.switchboard.mobile.data.outbox.OutboxObserver
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.data.outbox.RoomOutboxStore
import app.switchboard.mobile.data.remote.ReadyClientRegistry
import app.switchboard.mobile.data.remote.ReadyEndpointLookup
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.platform.migration.DialGate
import app.switchboard.mobile.platform.notification.AndroidAppVisibilityMonitor
import app.switchboard.mobile.platform.notification.AndroidNotificationPermissionController
import app.switchboard.mobile.platform.notification.AndroidNotificationRouteStorage
import app.switchboard.mobile.platform.notification.AndroidTurnCompletionNotifier
import app.switchboard.mobile.platform.notification.BackgroundTurnNotificationCoordinator
import app.switchboard.mobile.platform.notification.BackgroundTurnNotificationRuntime
import app.switchboard.mobile.platform.notification.NotificationRouteInbox
import app.switchboard.mobile.platform.notification.NotificationThreadMetadata
import app.switchboard.mobile.platform.outbox.AndroidPrivateFilesAttachmentStager
import app.switchboard.mobile.platform.outbox.PrivateFileOutboxImageMaterializer
import app.switchboard.mobile.platform.protocol.AuthenticatedConnectionFleetCoordinatorFactory
import app.switchboard.mobile.platform.protocol.ExecutorTransportScheduler
import app.switchboard.mobile.platform.protocol.OkHttpWebSocketDialer
import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.RoomResumeCursorStore
import app.switchboard.mobile.platform.startup.AndroidStartupRuntime
import app.switchboard.mobile.platform.startup.StartupRuntimeState
import app.switchboard.mobile.platform.storage.AndroidNativeCredentialPlatform
import app.switchboard.mobile.platform.storage.VerifiedNativeCredentialStore
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
    val startup: AndroidStartupRuntime,
    val deviceIdentity: StableDeviceIdentity,
    val notificationRoutes: NotificationRouteInbox,
    val notificationPermissions: AndroidNotificationPermissionController,
    private val scope: CoroutineScope,
    private val transportScheduler: ExecutorTransportScheduler,
    private val outboxScheduler: ExecutorTransportScheduler,
    private val retryScheduler: TransportOutboxRetryScheduler,
    private val httpClient: OkHttpClient,
    private val notificationRuntime: BackgroundTurnNotificationRuntime,
    private val visibilityMonitor: AndroidAppVisibilityMonitor,
) : Closeable {
    val connectionStatuses: StateFlow<Map<String, ConnectionRuntimeState>> =
        connectionFleet.statuses

    private val coordinator = ApplicationRuntimeCoordinator(
        seedRepository = connectionRepository::seed,
        startupOutbox = outbox::onStartupReady,
        wakeOutbox = outbox::onFleetChanged,
    )
    private val startupCompositionObservation = startup.observe(coordinator::onStartupState)
    private val fleetObservation: Job = scope.launch {
        connectionFleet.statuses.collect { coordinator.onFleetChanged() }
    }
    private var closed = false

    fun start() {
        startup.start()
    }

    fun observeStartup(observer: (StartupRuntimeState) -> Unit): Closeable = startup.observe(observer)

    /** Continues across Activity recreation; the application owns both this scope and the Room write. */
    fun removeConnection(connectionId: String) {
        if (connectionId.isBlank()) return
        scope.launch { connectionFleet.remove(connectionId) }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        startupCompositionObservation.close()
        fleetObservation.cancel()
        notificationRuntime.close()
        visibilityMonitor.close()
        connectionFleet.close()
        readyClients.clear()
        retryScheduler.close()
        protocolEvents.close()
        startup.close()
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
            val credentials = VerifiedNativeCredentialStore(
                AndroidNativeCredentialPlatform(applicationContext),
            )
            val connectionDatabase = RoomConnectionDatabase(database)
            val repository = NativeConnectionRepository(connectionDatabase, credentials)
            val identity = StableDeviceIdentityProvider(
                SharedPreferencesDeviceIdentityStorage(applicationContext),
            ).get()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val transportScheduler = ExecutorTransportScheduler()
            val outboxScheduler = ExecutorTransportScheduler()
            val retryScheduler = TransportOutboxRetryScheduler(outboxScheduler)
            val protocolEvents = ProtocolEventHub(bufferCapacity = PROTOCOL_EVENT_BUFFER)
            val httpClient = OkHttpClient()
            val fleet = ConnectionFleet(
                scope = scope,
                snapshots = RepositoryConnectionFleetSnapshotSource(repository),
                targetResolver = DeviceConnectionFleetTargetResolver(
                    resolver = NativeConnectionTargetResolver(connectionDatabase, credentials),
                    deviceId = identity.deviceId,
                    deviceLabel = identity.deviceLabel,
                ),
                coordinatorFactory = AuthenticatedConnectionFleetCoordinatorFactory(
                    dialer = OkHttpWebSocketDialer(httpClient),
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
            val visibilityMonitor = AndroidAppVisibilityMonitor.install(application)
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
            val startup = AndroidStartupRuntime.create(
                context = applicationContext,
                database = database,
                credentials = credentials,
                dialGate = DialGate(fleet::startupReady),
            )
            return NativeAndroidRuntime(
                database = database,
                connectionRepository = repository,
                connectionFleet = fleet,
                readyClients = clients,
                protocolEvents = protocolEvents,
                outbox = outbox,
                startup = startup,
                deviceIdentity = identity,
                notificationRoutes = notificationRoutes,
                notificationPermissions = notificationPermissions,
                scope = scope,
                transportScheduler = transportScheduler,
                outboxScheduler = outboxScheduler,
                retryScheduler = retryScheduler,
                httpClient = httpClient,
                notificationRuntime = notificationRuntime,
                visibilityMonitor = visibilityMonitor,
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
