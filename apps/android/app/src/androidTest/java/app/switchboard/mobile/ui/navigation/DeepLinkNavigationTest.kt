package app.switchboard.mobile.ui.navigation

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import app.switchboard.mobile.platform.deeplink.AppDeepLinkRoute
import app.switchboard.mobile.platform.deeplink.PendingAppDeepLink
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class DeepLinkNavigationTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun aFreshSettingsLinkReplacesTheCurrentRouteAndIsAcknowledgedOnce() {
        val pending = mutableStateOf<PendingAppDeepLink?>(null)
        val accepted = mutableListOf<Long>()
        compose.setContent {
            SwitchboardTheme {
                SwitchboardNavigation(
                    connectionsState = ConnectionsLoadState.Ready(emptyList()),
                    buildStamp = "test",
                    resolveEditForm = { null },
                    onConnectionIntent = {},
                    onPairingIntent = { PairingSaveResult.Failure("not used") },
                    pendingAppDeepLink = pending.value,
                    onAppDeepLinkAccepted = { accepted += it.requestId },
                )
            }
        }

        compose.runOnIdle {
            pending.value = PendingAppDeepLink(7, AppDeepLinkRoute.Settings)
        }

        compose.onNodeWithText("Settings").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(7L), accepted) }
    }
}
