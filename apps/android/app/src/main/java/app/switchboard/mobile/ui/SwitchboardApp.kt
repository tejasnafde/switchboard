package app.switchboard.mobile.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.AppContract
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.ui.connections.ConnectionIntent
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.navigation.RootNavigationRuntime
import app.switchboard.mobile.platform.notification.PendingNotificationRoute
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleCredentialImportResult
import app.switchboard.mobile.platform.google.GoogleSignOutResult
import app.switchboard.mobile.ui.navigation.SwitchboardNavigation
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import app.switchboard.mobile.ui.update.UpdateSurface
import app.switchboard.mobile.ui.update.UpdateSurfacePlacement
import app.switchboard.mobile.ui.update.UpdateSurfacePresentation
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
    googleAccountPresentation: GoogleAccountPresentation = GoogleAccountPresentation.SignedOut,
    onGoogleImportCredentials: suspend (String) -> GoogleCredentialImportResult = {
        GoogleCredentialImportResult.PersistenceFailed
    },
    onGoogleSignOut: suspend () -> GoogleSignOutResult = {
        GoogleSignOutResult.AlreadySignedOut
    },
    offlineSnapshot: OfflineSnapshot? = null,
    navigationRuntime: RootNavigationRuntime? = null,
    pendingNotificationRoute: PendingNotificationRoute? = null,
    notificationRouteWake: Long = 0,
    onNotificationRouteAccepted: (PendingNotificationRoute) -> Unit = {},
    updateState: UpdateState = UpdateState.Idle,
    onUpdateAction: (UpdateAction) -> Unit = {},
) {
    val updatePresentation = UpdateSurfacePresentation.from(updateState)
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(updatePresentation) {
        val presentation = updatePresentation
        if (presentation?.placement != UpdateSurfacePlacement.Snackbar) {
            snackbarHostState.currentSnackbarData?.dismiss()
            return@LaunchedEffect
        }
        val result = snackbarHostState.showSnackbar(
            message = presentation.snackbarMessage,
            actionLabel = presentation.actionLabel,
            withDismissAction = false,
            duration = SnackbarDuration.Indefinite,
        )
        if (result == SnackbarResult.ActionPerformed) {
            presentation.action?.let(onUpdateAction)
        }
    }
    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .imePadding(),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = {
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.navigationBarsPadding(),
            )
        },
        bottomBar = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding(),
            ) {
                if (updatePresentation?.placement == UpdateSurfacePlacement.ReservedBanner) {
                    UpdateSurface(
                        state = updateState,
                        onAction = onUpdateAction,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
        },
    ) { contentPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding),
        ) {
            SwitchboardNavigation(
                connectionsState = connectionsState,
                buildStamp = buildStamp,
                resolveEditForm = resolveEditForm,
                onConnectionIntent = onConnectionIntent,
                onPairingIntent = onPairingIntent,
                googleAccountPresentation = googleAccountPresentation,
                onGoogleImportCredentials = onGoogleImportCredentials,
                onGoogleSignOut = onGoogleSignOut,
                offlineSnapshot = offlineSnapshot,
                runtime = navigationRuntime,
                pendingNotificationRoute = pendingNotificationRoute,
                notificationRouteWake = notificationRouteWake,
                onNotificationRouteAccepted = onNotificationRouteAccepted,
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
