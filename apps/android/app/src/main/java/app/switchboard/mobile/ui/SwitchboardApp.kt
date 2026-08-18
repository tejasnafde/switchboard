package app.switchboard.mobile.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.AppContract
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.ui.connections.ConnectionIntent
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.navigation.RootNavigationRuntime
import app.switchboard.mobile.platform.notification.PendingNotificationRoute
import app.switchboard.mobile.ui.navigation.SwitchboardNavigation
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import app.switchboard.mobile.ui.update.UpdateSurface
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateState

@Composable
fun SwitchboardApp(
    modifier: Modifier = Modifier,
    connectionsState: ConnectionsLoadState = ConnectionsLoadState.Ready(emptyList()),
    buildStamp: String = "v${AppContract.VERSION_NAME} · native",
    resolveEditForm: (String) -> PairingForm? = { null },
    onConnectionIntent: (ConnectionIntent) -> Unit = {},
    onPairingIntent: suspend (PairingSaveIntent) -> PairingSaveResult = {
        PairingSaveResult.Failure("Saving connections is not available yet")
    },
    onQrUnavailable: () -> Unit = {},
    offlineSnapshot: OfflineSnapshot? = null,
    navigationRuntime: RootNavigationRuntime? = null,
    pendingNotificationRoute: PendingNotificationRoute? = null,
    notificationRouteWake: Long = 0,
    onNotificationRouteAccepted: (PendingNotificationRoute) -> Unit = {},
    updateState: UpdateState = UpdateState.Idle,
    onUpdateAction: (UpdateAction) -> Unit = {},
) {
    Surface(modifier = modifier.fillMaxSize()) {
        Box(modifier = Modifier.fillMaxSize()) {
            SwitchboardNavigation(
                connectionsState = connectionsState,
                buildStamp = buildStamp,
                resolveEditForm = resolveEditForm,
                onConnectionIntent = onConnectionIntent,
                onPairingIntent = onPairingIntent,
                onQrUnavailable = onQrUnavailable,
                offlineSnapshot = offlineSnapshot,
                runtime = navigationRuntime,
                pendingNotificationRoute = pendingNotificationRoute,
                notificationRouteWake = notificationRouteWake,
                onNotificationRouteAccepted = onNotificationRouteAccepted,
            )

            UpdateSurface(
                state = updateState,
                onAction = onUpdateAction,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            )
        }
    }
}

@Preview
@Composable
private fun SwitchboardAppPreview() {
    SwitchboardTheme {
        SwitchboardApp()
    }
}
