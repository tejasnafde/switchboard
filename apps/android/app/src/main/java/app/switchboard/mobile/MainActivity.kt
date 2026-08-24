package app.switchboard.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.graphics.Color
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import app.switchboard.mobile.ui.SwitchboardApp
import app.switchboard.mobile.ui.connections.ConnectionIntent
import app.switchboard.mobile.ui.connections.StartupConnectionsMapper
import app.switchboard.mobile.ui.navigation.AndroidRootNavigationRuntime
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import app.switchboard.mobile.platform.startup.StartupRuntimeState
import app.switchboard.mobile.platform.deeplink.AndroidDeepLinkIntentAdapter
import app.switchboard.mobile.platform.deeplink.PendingAppDeepLink
import app.switchboard.mobile.platform.deeplink.SwitchboardDeepLinkContract
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val notificationRouteWake = MutableStateFlow(0L)
    private val appDeepLinkRequest = MutableStateFlow<PendingAppDeepLink?>(null)
    private var nextAppDeepLinkRequestId = 0L

    private val switchboardApplication
        get() = application as SwitchboardApplication

    private val updateRuntime
        get() = switchboardApplication.updateRuntime

    private val connectionRepository
        get() = switchboardApplication.connectionRepository

    private val navigationRuntime by lazy {
        AndroidRootNavigationRuntime(
            fleet = switchboardApplication.connectionFleet,
            clients = switchboardApplication.readyClients,
            outbox = switchboardApplication.outboxRuntime,
            composer = switchboardApplication.composerRuntime,
            protocolEvents = switchboardApplication.protocolEvents,
            removeConnection = switchboardApplication::removeConnection,
            activity = switchboardApplication::browseActivity,
            persistCollapsedWorkspaceIds = switchboardApplication::saveCollapsedWorkspaceIds,
            snapshots = switchboardApplication.browseSnapshotStore,
            worktreeCreations = switchboardApplication.worktreeCreationStore,
            threadSnapshots = switchboardApplication.threadSnapshotStore,
            beginViewingLease = switchboardApplication::beginPushViewing,
            registerViewingRenewal = switchboardApplication::registerViewingLeaseRenewal,
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        ensureNotificationChannel()
        switchboardApplication.notificationPermissions.requestIfNeeded(this)
        switchboardApplication.ingestRemoteNotificationIntent(intent)
        if (savedInstanceState == null) ingestAppDeepLinkIntent(intent, coldStart = true)
        setContent {
            val updateState by updateRuntime.state
            val startupState by switchboardApplication.startupState.collectAsState()
            val connectionSnapshot by connectionRepository.snapshots.collectAsState()
            val googleAccountPresentation by switchboardApplication.googleAccountRuntime
                .presentation
                .collectAsState()
            val routeWake by notificationRouteWake.collectAsState()
            val pendingAppDeepLink by appDeepLinkRequest.collectAsState()
            val visibleStartupState = when {
                startupState is StartupRuntimeState.Ready && connectionSnapshot != null ->
                    (startupState as StartupRuntimeState.Ready).copy(
                        offlineSnapshot = requireNotNull(connectionSnapshot),
                    )
                else -> startupState
            }
            SwitchboardTheme {
                SwitchboardApp(
                    connectionsState = StartupConnectionsMapper.map(visibleStartupState),
                    resolveEditForm = connectionRepository::editForm,
                    onPairingIntent = connectionRepository::save,
                    googleAccountPresentation = googleAccountPresentation,
                    onGoogleImportCredentials =
                        switchboardApplication.googleAccountRuntime::importCredentials,
                    onGoogleSignOut = switchboardApplication.googleAccountRuntime::signOut,
                    onConnectionIntent = { intent ->
                        when (intent) {
                            is ConnectionIntent.Remove -> {
                                switchboardApplication.removeConnection(intent.connectionId)
                            }

                            ConnectionIntent.Retry -> switchboardApplication.retryStartup()
                            else -> Unit
                        }
                    },
                    offlineSnapshot = (visibleStartupState as? StartupRuntimeState.Ready)
                        ?.offlineSnapshot,
                    navigationRuntime = navigationRuntime,
                    pendingNotificationRoute = switchboardApplication.notificationRoutes.peek(),
                    notificationRouteWake = routeWake,
                    onNotificationRouteAccepted = { accepted ->
                        if (
                            switchboardApplication.notificationRoutes.peek()?.tapId == accepted.tapId
                        ) {
                            val consumed = switchboardApplication.notificationRoutes.consume()
                            if (consumed?.tapId == accepted.tapId) signalNotificationRoute()
                        }
                    },
                    pendingAppDeepLink = pendingAppDeepLink,
                    onAppDeepLinkAccepted = { accepted ->
                        if (appDeepLinkRequest.value?.requestId == accepted.requestId) {
                            appDeepLinkRequest.value = null
                        }
                    },
                    updateState = updateState,
                    updatesEnabled = updateRuntime.enabled,
                    onUpdateAction = updateRuntime::onAction,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        signalNotificationRoute()
        updateRuntime.onActivityResumed()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        switchboardApplication.ingestRemoteNotificationIntent(intent)
        ingestAppDeepLinkIntent(intent, coldStart = false)
        signalNotificationRoute()
    }

    override fun onPause() {
        updateRuntime.onActivityPaused()
        super.onPause()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                AppContract.NOTIFICATION_CHANNEL_ID,
                AppContract.NOTIFICATION_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH,
            ),
        )
    }

    private fun signalNotificationRoute() {
        notificationRouteWake.value += 1
    }

    private fun ingestAppDeepLinkIntent(intent: Intent, coldStart: Boolean): Boolean {
        val data = AndroidDeepLinkIntentAdapter.dataString(intent) ?: return false
        val route = SwitchboardDeepLinkContract.appRoute(data)
        val audit = SwitchboardDeepLinkContract.auditFields(data)
        Log.i(
            DEEP_LINK_LOG_TAG,
            "received cold=$coldStart scheme=${audit.scheme} authority=${audit.authority} " +
                "path=${audit.path} classification=${SwitchboardDeepLinkContract.classify(data)} " +
                "route=${route?.name ?: "none"}",
        )
        if (route == null) return false
        appDeepLinkRequest.value = PendingAppDeepLink(
            requestId = ++nextAppDeepLinkRequestId,
            route = route,
        )
        return true
    }

    private companion object {
        const val DEEP_LINK_LOG_TAG = "SwitchboardDeepLink"
    }
}
