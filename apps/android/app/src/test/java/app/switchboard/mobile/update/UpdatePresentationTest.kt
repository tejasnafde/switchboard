package app.switchboard.mobile.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePresentationTest {
    private val release = UpdateRelease("0.6.0", "https://example.test/update.apk")

    @Test
    fun availabilityNamesTheExactVersionAndOffersDownload() {
        val presentation = UpdatePresentation.from(UpdateState.Available(release))

        assertEquals("Switchboard 0.6.0 is available", presentation.title)
        assertEquals(UpdateAction.DOWNLOAD, presentation.primaryAction)
        assertTrue(presentation.visible)
    }

    @Test
    fun downloadProgressIsDeterminateOnlyWithAUsefulTotal() {
        val known = UpdatePresentation.from(UpdateState.Downloading(release, 25, 100))
        val unknown = UpdatePresentation.from(UpdateState.Downloading(release, 25, null))

        assertEquals(0.25f, known.progressFraction)
        assertNull(unknown.progressFraction)
        assertEquals(UpdateAction.CANCEL, known.primaryAction)
    }

    @Test
    fun errorsAndUnknownSourceRecoveryStayVisible() {
        val artifact = VerifiedApk(release, "/cache/update.apk", "content://update.apk")
        val permission = UpdatePresentation.from(UpdateState.PermissionRequired(release, artifact))
        val error = UpdatePresentation.from(UpdateState.Error(UpdateStage.INSTALLER, "Installer unavailable"))

        assertEquals(UpdateAction.OPEN_SETTINGS, permission.primaryAction)
        assertEquals("Installer unavailable", error.detail)
        assertEquals(UpdateAction.RETRY, error.primaryAction)
        assertTrue(error.visible)
    }

    @Test
    fun idleDoesNotShowAnUpdateBanner() {
        val presentation = UpdatePresentation.from(UpdateState.Idle)

        assertFalse(presentation.visible)
        assertNull(presentation.primaryAction)
    }
}
