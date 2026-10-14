package app.switchboard.mobile.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import app.switchboard.mobile.BuildConfig
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.ui.connections.ConnectionIntent
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.navigation.PhoneDemoController
import app.switchboard.mobile.ui.navigation.RootNavigationRuntime
import app.switchboard.mobile.platform.notification.PendingNotificationRoute
import app.switchboard.mobile.platform.deeplink.PendingAppDeepLink
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleCredentialImportResult
import app.switchboard.mobile.platform.google.GoogleSignOutResult
import app.switchboard.mobile.ui.navigation.SwitchboardNavigation
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.theme.SwitchboardTheme

@Composable
fun SwitchboardApp(
    modifier: Modifier = Modifier,
    connectionsState: ConnectionsLoadState = ConnectionsLoadState.Ready(emptyList()),
    buildStamp: String = "v${BuildConfig.VERSION_NAME} · native",
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
    pendingAppDeepLink: PendingAppDeepLink? = null,
    onAppDeepLinkAccepted: (PendingAppDeepLink) -> Unit = {},
    phoneDemo: PhoneDemoController? = null,
) {
    Scaffold(
        modifier = modifier
            .fillMaxSize()
            .imePadding(),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        // Keeps content above the navigation bar.
        bottomBar = { Spacer(Modifier.fillMaxWidth().navigationBarsPadding()) },
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
                pendingAppDeepLink = pendingAppDeepLink,
                onAppDeepLinkAccepted = onAppDeepLinkAccepted,
                phoneDemo = phoneDemo,
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
