package app.switchboard.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.graphics.Color
import android.content.Intent
import android.os.Build
import android.os.Bundle
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
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val notificationRouteWake = MutableStateFlow(0L)

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
            protocolEvents = switchboardApplication.protocolEvents,
            removeConnection = switchboardApplication::removeConnection,
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
        setContent {
            val updateState by updateRuntime.state
            val startupState by switchboardApplication.startupState.collectAsState()
            val connectionSnapshot by connectionRepository.snapshots.collectAsState()
            val routeWake by notificationRouteWake.collectAsState()
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
                    onConnectionIntent = { intent ->
                        if (intent is ConnectionIntent.Remove) {
                            switchboardApplication.removeConnection(intent.connectionId)
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
                    updateState = updateState,
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
}
