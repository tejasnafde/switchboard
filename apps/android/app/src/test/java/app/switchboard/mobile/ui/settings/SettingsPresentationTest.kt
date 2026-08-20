package app.switchboard.mobile.ui.settings

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.connections.ConnectionItem
import app.switchboard.mobile.ui.connections.ConnectionKind
import app.switchboard.mobile.ui.connections.ConnectionStatus
import app.switchboard.mobile.ui.connections.ConnectionTarget
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateStage
import app.switchboard.mobile.update.UpdateState
import app.switchboard.mobile.update.VerifiedApk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
            updateState = UpdateState.Idle,
            versionName = "0.5.5",
            updatesEnabled = true,
        )

        assertEquals("tejas@example.com", presentation.accountDetail)
        assertEquals("1 of 2 live", presentation.machinesDetail)
        assertEquals("Version 0.5.5", presentation.versionDetail)
        assertFalse(presentation.accountDetail.contains("token", ignoreCase = true))
    }

    @Test
    fun `manual update row exposes only the action valid for the current state`() {
        val available = SettingsPresenter.updateRow(
            UpdateState.Available(UpdateRelease("0.5.6", "https://example.test/app.apk")),
            versionName = "0.5.5",
            enabled = true,
        )
        val downloading = SettingsPresenter.updateRow(
            UpdateState.Downloading(
                release = UpdateRelease("0.5.6", "https://example.test/app.apk"),
                bytesDownloaded = 5,
                totalBytes = 10,
            ),
            versionName = "0.5.5",
            enabled = true,
        )
        val ready = SettingsPresenter.updateRow(
            UpdateState.InstallerReady(
                VerifiedApk(
                    release = UpdateRelease("0.5.6", "https://example.test/app.apk"),
                    filePath = "/tmp/app.apk",
                    contentUri = "content://app.apk",
                ),
            ),
            versionName = "0.5.5",
            enabled = true,
        )

        assertEquals(UpdateAction.DOWNLOAD, available.action)
        assertEquals("Download", available.actionLabel)
        assertEquals(UpdateAction.CANCEL, downloading.action)
        assertTrue(downloading.busy)
        assertEquals(UpdateAction.INSTALL, ready.action)
    }

    @Test
    fun `idle and completed checks stay compact while failures remain actionable`() {
        val idle = SettingsPresenter.updateRow(UpdateState.Idle, "0.5.5", enabled = true)
        val current = SettingsPresenter.updateRow(UpdateState.UpToDate, "0.5.5", enabled = true)
        val checking = SettingsPresenter.updateRow(UpdateState.Checking, "0.5.5", enabled = true)
        val error = SettingsPresenter.updateRow(
            UpdateState.Error(UpdateStage.DISCOVERY, "Network unavailable"),
            "0.5.5",
            enabled = true,
        )
        val debug = SettingsPresenter.updateRow(UpdateState.Idle, "0.5.5-native-dev", enabled = false)

        assertEquals(UpdateAction.CHECK, idle.action)
        assertEquals("Up to date · 0.5.5", current.detail)
        assertNull(checking.action)
        assertTrue(checking.busy)
        assertEquals(UpdateAction.RETRY, error.action)
        assertEquals("Network unavailable", error.detail)
        assertNull(debug.action)
        assertEquals("Updates are available in production builds", debug.detail)
    }

    private fun connection(id: String, status: ConnectionStatus) = ConnectionItem(
        id = id,
        label = id,
        kind = ConnectionKind.WEBSOCKET,
        target = ConnectionTarget.WebSocket("ws://127.0.0.1"),
        status = status,
    )
}
