package app.switchboard.mobile.ui.home

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.domain.connection.ConnectionSecurityCopy
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.connections.ConnectionItem
import app.switchboard.mobile.ui.connections.ConnectionKind
import app.switchboard.mobile.ui.connections.ConnectionStatus
import app.switchboard.mobile.ui.connections.ConnectionTarget
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.connections.ConnectionsPresenter
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Home's machine list uses the Connections screen's rows: same transport copy, hint and certificate sheet. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class HomeMachineRowsTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val fp = "7c0e51b2" + "a".repeat(56)
    private val opened = mutableListOf<String>()
    private val rescanned = mutableListOf<String>()
    private val removed = mutableListOf<String>()
    private var iapTaps = 0

    private fun ws(id: String, label: String, url: String, certificateChanged: Boolean = false) = ConnectionItem(
        id = id,
        label = label,
        kind = ConnectionKind.WEBSOCKET,
        target = ConnectionTarget.WebSocket(url),
        status = ConnectionStatus.OFFLINE,
        certificateChanged = certificateChanged,
    )

    private fun show(vararg items: ConnectionItem) {
        compose.setContent {
            SwitchboardTheme {
                HomeScreen(
                    recents = HomeRecentsPage(emptyList(), 0),
                    machines = ConnectionsPresenter.present(
                        ConnectionsLoadState.Ready(items.toList()),
                        requireEncryption = true,
                    ),
                    googleAccount = GoogleAccountPresentation.SignedOut,
                    onRecent = {},
                    onMachine = { opened += it },
                    onShowMore = {},
                    onManageMachines = {},
                    onAddMachine = {},
                    onGoogleAccount = {},
                    onSettings = {},
                    onRetryMachines = {},
                    onRescan = { rescanned += it },
                    onUseIap = { iapTaps++ },
                    onRemoveMachine = { removed += it },
                )
            }
        }
    }

    @Test
    fun showsTheTransportOfEachMachine() {
        show(
            ws("pinned", "studio", "wss://192.168.1.24:8765?fp=$fp"),
            ws("local", "laptop", "ws://127.0.0.1:8765"),
            ConnectionItem(
                id = "iap",
                label = "build-vm",
                kind = ConnectionKind.IAP,
                target = ConnectionTarget.Iap("build-vm", "asia-south1-a"),
                status = ConnectionStatus.OFFLINE,
            ),
        )
        compose.onNodeWithText(ConnectionSecurityCopy.PINNED, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("7c0e51b2", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(ConnectionSecurityCopy.LOCAL, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(ConnectionSecurityCopy.IAP, useUnmergedTree = true).assertIsDisplayed()

        compose.onNodeWithText("studio", useUnmergedTree = true).performClick()
        assertEquals(listOf("pinned"), opened)
    }

    @Test
    fun refusedRowShowsTheAmberHint() {
        show(ws("plain", "office", "ws://192.168.1.30:8765"))
        compose.onNodeWithText(ConnectionSecurityCopy.REFUSED, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(ConnectionSecurityCopy.REFUSED_HINT).assertIsDisplayed()

        compose.onNodeWithText(ConnectionSecurityCopy.SCAN_NEW_QR).performClick()
        compose.onNodeWithText(ConnectionSecurityCopy.USE_CLOUD_IAP).performClick()
        assertEquals(listOf("plain"), rescanned)
        assertEquals(1, iapTaps)
    }

    @Test
    fun certificateChangedRowOpensTheSheetNotTheMachine() {
        show(ws("changed", "studio", "wss://192.168.1.40:8765?fp=$fp", certificateChanged = true))
        compose.onNodeWithText(ConnectionSecurityCopy.CERTIFICATE_CHANGED, useUnmergedTree = true).assertIsDisplayed()

        compose.onNodeWithText("studio", useUnmergedTree = true).performClick()
        compose.onNodeWithText(ConnectionSecurityCopy.CERTIFICATE_EXPECTED_TITLE).assertIsDisplayed()
        assertEquals(emptyList<String>(), opened)

        compose.onNodeWithText(ConnectionSecurityCopy.REMOVE_MACHINE).performClick()
        compose.onNodeWithText("Remove").performClick()
        assertEquals(listOf("changed"), removed)
    }
}
