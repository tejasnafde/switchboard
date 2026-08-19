package app.switchboard.mobile.ui.update

import app.switchboard.mobile.update.DownloadedApk
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateStage
import app.switchboard.mobile.update.UpdateState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateSurfacePresentationTest {
    private val release = UpdateRelease("1.2.3", "https://example.test/app.apk")

    @Test
    fun `idle update state reserves no root surface`() {
        assertNull(UpdateSurfacePresentation.from(UpdateState.Idle))
    }

    @Test
    fun `actionable update states use a scaffold snackbar`() {
        val available = UpdateSurfacePresentation.from(UpdateState.Available(release))
        val failed = UpdateSurfacePresentation.from(
            UpdateState.Error(UpdateStage.DOWNLOAD, "Network unavailable", release = release),
        )

        assertEquals(UpdateSurfacePlacement.Snackbar, available?.placement)
        assertEquals(UpdateAction.DOWNLOAD, available?.action)
        assertEquals("Switchboard 1.2.3 is available", available?.message)
        assertEquals(UpdateSurfacePlacement.Snackbar, failed?.placement)
        assertEquals(UpdateAction.RETRY, failed?.action)
    }

    @Test
    fun `ongoing update work uses a reserved compact banner`() {
        val downloading = UpdateSurfacePresentation.from(
            UpdateState.Downloading(release, bytesDownloaded = 50, totalBytes = 100),
        )
        val verifying = UpdateSurfacePresentation.from(
            UpdateState.Verifying(DownloadedApk(release, "/tmp/update.apk")),
        )

        assertEquals(UpdateSurfacePlacement.ReservedBanner, downloading?.placement)
        assertEquals(0.5f, downloading?.progressFraction)
        assertEquals(UpdateSurfacePlacement.ReservedBanner, verifying?.placement)
    }
}
