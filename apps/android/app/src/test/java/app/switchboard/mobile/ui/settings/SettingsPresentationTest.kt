package app.switchboard.mobile.ui.settings

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.connections.ConnectionItem
import app.switchboard.mobile.ui.connections.ConnectionKind
import app.switchboard.mobile.ui.connections.ConnectionStatus
import app.switchboard.mobile.ui.connections.ConnectionTarget
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SettingsPresentationTest {
    @Test
    fun `settings summarize account and machine state without exposing credentials`() {
        val presentation = SettingsPresenter.present(
            account = GoogleAccountPresentation.SignedIn("tejas@example.com"),
            connections = ConnectionsLoadState.Ready(
                listOf(
                    connection("mac", ConnectionStatus.LIVE),
                    connection("vm", ConnectionStatus.OFFLINE),
                ),
            ),
            versionName = "0.5.5",
        )

        assertEquals("tejas@example.com", presentation.accountDetail)
        assertEquals("1 of 2 live", presentation.machinesDetail)
        assertEquals("Version 0.5.5", presentation.versionDetail)
        assertFalse(presentation.accountDetail.contains("token", ignoreCase = true))
    }

    private fun connection(id: String, status: ConnectionStatus) = ConnectionItem(
        id = id,
        label = id,
        kind = ConnectionKind.WEBSOCKET,
        target = ConnectionTarget.WebSocket("ws://127.0.0.1"),
        status = status,
    )
}
