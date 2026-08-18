package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.DownloadedApk
import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateStage
import app.switchboard.mobile.update.UpdateState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateStateCodecTest {
    private val release = UpdateRelease(
        version = "0.6.0",
        apkUrl = "https://example.test/switchboard.apk",
        expectedSha256 = "deadbeef",
    )

    @Test
    fun roundTripsResumableAndErrorStatesWithoutLosingArtifactIdentity() {
        val downloaded = DownloadedApk(release, "/cache/updates/switchboard.apk.part")
        val verified = verifiedApk(release)
        val states = listOf(
            UpdateState.Downloading(release, 51, 100),
            UpdateState.Cancelling(release, 51, 100),
            UpdateState.Verifying(downloaded),
            UpdateState.InstallerReady(verified),
            UpdateState.PermissionRequired(release, verified),
            UpdateState.Error(
                stage = UpdateStage.VERIFICATION,
                message = "Digest mismatch",
                release = release,
                downloadedApk = downloaded,
            ),
        )

        states.forEach { state ->
            assertEquals(state, UpdateStateCodec.decode(UpdateStateCodec.encode(state)))
        }
    }

    @Test
    fun corruptPersistenceIsIgnoredInsteadOfBlockingStartup() {
        assertNull(UpdateStateCodec.decode(mapOf("type" to "downloading", "version" to "0.6.0")))
        assertNull(UpdateStateCodec.decode(mapOf("type" to "future-state")))
    }
}
