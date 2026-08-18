package app.switchboard.mobile.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateStateMachineTest {
    private val release = UpdateRelease(
        version = "0.6.0",
        apkUrl = "https://example.test/switchboard-0.6.0.apk",
        expectedSha256 = "abc123",
    )

    @Test
    fun discoveryMakesANewerReleaseVisible() {
        val machine = UpdateStateMachine("0.5.0")

        assertEquals(UpdateEffect.FetchReleases, machine.dispatch(UpdateEvent.CheckRequested).effect)
        val loaded = machine.dispatch(
            UpdateEvent.ReleasesLoaded(
                listOf(
                    GitHubRelease(
                        tagName = "mobile-v0.6.0",
                        draft = false,
                        prerelease = false,
                        assets = listOf(
                            GitHubAsset("switchboard-0.6.0.apk", release.apkUrl, "sha256:abc123"),
                        ),
                    ),
                ),
            ),
        )

        assertEquals(UpdateState.Available(release), loaded.state)
        assertNull(loaded.effect)
    }

    @Test
    fun aRepeatedDownloadTapCannotStartAnotherDownload() {
        val machine = availableMachine()

        val first = machine.dispatch(UpdateEvent.DownloadRequested)
        val second = machine.dispatch(UpdateEvent.DownloadRequested)

        assertEquals(UpdateState.Downloading(release, 0, null), first.state)
        assertEquals(UpdateEffect.StartDownload(release), first.effect)
        assertSame(first.state, second.state)
        assertNull(second.effect)
    }

    @Test
    fun progressSupportsKnownAndUnknownTotalsAndRejectsStaleReleases() {
        val machine = availableMachine()
        machine.dispatch(UpdateEvent.DownloadRequested)

        assertEquals(
            UpdateState.Downloading(release, 25, 100),
            machine.dispatch(UpdateEvent.DownloadProgress(release.version, 25, 100)).state,
        )
        assertEquals(
            UpdateState.Downloading(release, 40, null),
            machine.dispatch(UpdateEvent.DownloadProgress(release.version, 40, null)).state,
        )
        assertEquals(
            UpdateState.Downloading(release, 40, null),
            machine.dispatch(UpdateEvent.DownloadProgress("9.9.9", 90, 100)).state,
        )
    }

    @Test
    fun cancellationWaitsForTheDownloaderBeforeOfferingTheReleaseAgain() {
        val machine = availableMachine()
        machine.dispatch(UpdateEvent.DownloadRequested)
        machine.dispatch(UpdateEvent.DownloadProgress(release.version, 10, 100))

        val cancelling = machine.dispatch(UpdateEvent.CancelRequested)
        assertEquals(UpdateEffect.CancelDownload, cancelling.effect)
        assertTrue(cancelling.state is UpdateState.Cancelling)
        assertNull(machine.dispatch(UpdateEvent.CancelRequested).effect)

        assertEquals(
            UpdateState.Available(release),
            machine.dispatch(UpdateEvent.DownloadCancelled).state,
        )
    }

    @Test
    fun aDownloadedFileIsNotInstallerReadyUntilVerificationSucceeds() {
        val machine = availableMachine()
        machine.dispatch(UpdateEvent.DownloadRequested)
        val downloaded = DownloadedApk(release, "/cache/update.part")

        val verifying = machine.dispatch(UpdateEvent.DownloadCompleted(downloaded))
        assertEquals(UpdateState.Verifying(downloaded), verifying.state)
        assertEquals(UpdateEffect.VerifyDownload(downloaded), verifying.effect)

        val verified = VerifiedApk(release, "/cache/update.apk", "content://updates/update.apk")
        assertEquals(
            UpdateState.InstallerReady(verified),
            machine.dispatch(UpdateEvent.VerificationSucceeded(verified)).state,
        )
    }

    @Test
    fun unknownSourcesRecoveryRechecksPermissionBeforeLaunching() {
        val verified = readyMachine()

        assertEquals(
            UpdateEffect.CheckInstallPermission,
            verified.dispatch(UpdateEvent.InstallRequested).effect,
        )
        assertEquals(
            UpdateState.PermissionRequired(release, readyArtifact()),
            verified.dispatch(UpdateEvent.InstallPermissionChecked(false)).state,
        )
        assertEquals(
            UpdateEffect.OpenUnknownSourcesSettings,
            verified.dispatch(UpdateEvent.OpenPermissionSettingsRequested).effect,
        )
        assertEquals(
            UpdateEffect.CheckInstallPermission,
            verified.dispatch(UpdateEvent.PermissionSettingsReturned).effect,
        )

        val launch = verified.dispatch(UpdateEvent.InstallPermissionChecked(true))
        assertTrue(launch.state is UpdateState.LaunchRequested)
        assertEquals(UpdateEffect.LaunchInstaller(readyArtifact()), launch.effect)
    }

    @Test
    fun errorsRemainVisibleAndRetryTheFailedStage() {
        val machine = availableMachine()
        machine.dispatch(UpdateEvent.DownloadRequested)
        val failed = machine.dispatch(UpdateEvent.Failed(UpdateStage.DOWNLOAD, "Network lost"))

        assertEquals(UpdateStage.DOWNLOAD, (failed.state as UpdateState.Error).stage)
        assertEquals("Network lost", failed.state.message)

        val retry = machine.dispatch(UpdateEvent.RetryRequested)
        assertEquals(UpdateEffect.StartDownload(release), retry.effect)
        assertTrue(retry.state is UpdateState.Downloading)
    }

    private fun availableMachine(): UpdateStateMachine = UpdateStateMachine("0.5.0").also {
        it.restore(UpdateState.Available(release))
    }

    private fun readyArtifact() = VerifiedApk(
        release = release,
        filePath = "/cache/update.apk",
        contentUri = "content://updates/update.apk",
    )

    private fun readyMachine(): UpdateStateMachine = UpdateStateMachine("0.5.0").also {
        it.restore(UpdateState.InstallerReady(readyArtifact()))
    }
}
