package app.switchboard.mobile

import android.app.Application
import android.content.Intent
import app.switchboard.mobile.data.connection.ConnectionFleet
import app.switchboard.mobile.data.connection.NativeConnectionRepository
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.data.remote.ReadyClientRegistry
import app.switchboard.mobile.platform.notification.AndroidNotificationPermissionController
import app.switchboard.mobile.platform.notification.NotificationRouteInbox
import app.switchboard.mobile.platform.push.AndroidRemotePushIntent
import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.platform.startup.AndroidStartupRuntime
import app.switchboard.mobile.platform.startup.StartupRuntimeState
import app.switchboard.mobile.platform.update.AndroidUpdateRuntime
import app.switchboard.mobile.runtime.NativeAndroidRuntime
import app.switchboard.mobile.runtime.DurableComposerRuntime
import app.switchboard.mobile.ui.browse.BrowseThreadActivity
import java.io.Closeable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class SwitchboardApplication : Application() {
    lateinit var updateRuntime: AndroidUpdateRuntime
        private set
    lateinit var startupRuntime: AndroidStartupRuntime
        private set
    lateinit var connectionRepository: NativeConnectionRepository
        private set
    lateinit var connectionFleet: ConnectionFleet
        private set
    lateinit var readyClients: ReadyClientRegistry
        private set
    lateinit var protocolEvents: ProtocolEventHub
        private set
    lateinit var outboxRuntime: OutboxRuntime
        private set
    lateinit var composerRuntime: DurableComposerRuntime
        private set
    lateinit var notificationRoutes: NotificationRouteInbox
        private set
    lateinit var notificationPermissions: AndroidNotificationPermissionController
        private set

    private val mutableStartupState = MutableStateFlow<StartupRuntimeState>(StartupRuntimeState.Loading)
    val startupState = mutableStartupState.asStateFlow()
    private lateinit var nativeRuntime: NativeAndroidRuntime
    private var startupObservation: Closeable? = null

    override fun onCreate() {
        super.onCreate()
        updateRuntime = AndroidUpdateRuntime(this)
        updateRuntime.start()
        nativeRuntime = NativeAndroidRuntime.create(this)
        startupRuntime = nativeRuntime.startup
        connectionRepository = nativeRuntime.connectionRepository
        connectionFleet = nativeRuntime.connectionFleet
        readyClients = nativeRuntime.readyClients
        protocolEvents = nativeRuntime.protocolEvents
        outboxRuntime = nativeRuntime.outbox
        composerRuntime = nativeRuntime.composer
        notificationRoutes = nativeRuntime.notificationRoutes
        notificationPermissions = nativeRuntime.notificationPermissions
        startupObservation = nativeRuntime.observeStartup { mutableStartupState.value = it }
        nativeRuntime.start()
    }

    override fun onTerminate() {
        startupObservation?.close()
        startupObservation = null
        if (::nativeRuntime.isInitialized) nativeRuntime.close()
        super.onTerminate()
    }

    fun removeConnection(connectionId: String) {
        nativeRuntime.removeConnection(connectionId)
    }

    fun registerViewingLeaseRenewal(callback: () -> Unit): Closeable =
        nativeRuntime.viewingLeaseRenewals.register(callback)

    fun beginPushViewing(connectionId: String, threadId: String): Closeable =
        nativeRuntime.beginViewing(connectionId, threadId)

    fun onFcmToken(token: String) {
        if (::nativeRuntime.isInitialized) nativeRuntime.onFcmToken(token)
    }

    fun ingestRemoteNotificationIntent(intent: Intent?): Boolean =
        AndroidRemotePushIntent.ingest(intent, notificationRoutes)

    fun browseActivity(scope: TransportScope): StateFlow<Map<String, BrowseThreadActivity>> =
        nativeRuntime.browseActivity(scope)

    fun saveCollapsedWorkspaceIds(connectionId: String, workspaceIds: Set<String>) {
        nativeRuntime.saveCollapsedWorkspaceIds(connectionId, workspaceIds)
    }
}
