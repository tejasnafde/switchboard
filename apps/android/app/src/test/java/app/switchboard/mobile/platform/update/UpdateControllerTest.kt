package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.DownloadedApk
import app.switchboard.mobile.update.UpdateEffect
import app.switchboard.mobile.update.UpdateEvent
import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateStage
import app.switchboard.mobile.update.UpdateState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class UpdateControllerTest {
    private val release = UpdateRelease(
        version = "0.6.0",
        apkUrl = "https://example.test/switchboard.apk",
        expectedSha256 = "abc123",
    )

    @Test
    fun startChecksForUpdatesAndPersistsTheVisibleState() {
        val runner = RecordingEffectRunner()
        val persistence = MemoryUpdateStatePersistence()
        val controller = UpdateController("0.5.0", runner, persistence)

        controller.start()

        assertEquals(UpdateState.Checking, controller.state)
        assertEquals(UpdateState.Checking, persistence.saved)
        assertEquals(UpdateEffect.FetchReleases, runner.invocations.single().effect)
    }

    @Test
    fun restoredUpToDateStateStartsExactlyOneFreshDiscoveryCheck() {
        val runner = RecordingEffectRunner()
        val persistence = MemoryUpdateStatePersistence(UpdateState.UpToDate)
        val controller = UpdateController("0.5.0", runner, persistence)

        controller.start()
        controller.start()

        assertEquals(UpdateState.Checking, controller.state)
        assertEquals(UpdateState.Checking, persistence.saved)
        assertEquals(listOf(UpdateEffect.FetchReleases), runner.invocations.map { it.effect })
    }

    @Test
    fun repeatedTapAndStaleDownloadCallbacksCannotSupersedeCancellation() {
        val runner = RecordingEffectRunner()
        val controller = UpdateController(
            currentVersion = "0.5.0",
            effectRunner = runner,
            persistence = MemoryUpdateStatePersistence(UpdateState.Available(release)),
        )
        controller.start()

        controller.dispatch(UpdateEvent.DownloadRequested)
        controller.dispatch(UpdateEvent.DownloadRequested)
        assertEquals(1, runner.invocations.size)

        controller.dispatch(UpdateEvent.CancelRequested)
        assertEquals(UpdateEffect.CancelDownload, runner.invocations[1].effect)

        runner.invocations[0].emit(
            UpdateEvent.DownloadCompleted(DownloadedApk(release, "/cache/stale.part")),
        )
        assertEquals(UpdateState.Cancelling(release, 0, null), controller.state)

        runner.invocations[1].emit(UpdateEvent.DownloadCancelled)
        assertEquals(UpdateState.Available(release), controller.state)
    }

    @Test
    fun restoredDownloadsResumeAndStartIsIdempotent() {
        val runner = RecordingEffectRunner()
        val restored = UpdateState.Downloading(release, 128, 1024)
        val controller = UpdateController(
            currentVersion = "0.5.0",
            effectRunner = runner,
            persistence = MemoryUpdateStatePersistence(restored),
        )

        controller.start()
        controller.start()

        assertSame(restored, controller.state)
        assertEquals(listOf(UpdateEffect.StartDownload(release)), runner.invocations.map { it.effect })
    }

    @Test
    fun restoredDownloadedFilesAreReverifiedBeforeBecomingInstallerReady() {
        val runner = RecordingEffectRunner()
        val downloaded = DownloadedApk(release, "/cache/switchboard.apk.part")
        val controller = UpdateController(
            currentVersion = "0.5.0",
            effectRunner = runner,
            persistence = MemoryUpdateStatePersistence(UpdateState.Verifying(downloaded)),
        )

        controller.start()

        assertEquals(UpdateEffect.VerifyDownload(downloaded), runner.invocations.single().effect)
    }

    @Test
    fun installerLaunchIsNeverRepeatedAfterProcessRecreation() {
        val runner = RecordingEffectRunner()
        val artifact = verifiedApk(release)
        val persistence = MemoryUpdateStatePersistence(UpdateState.LaunchRequested(artifact))
        val controller = UpdateController("0.5.0", runner, persistence)

        controller.start()

        assertEquals(UpdateState.InstallerReady(artifact), controller.state)
        assertEquals(UpdateState.InstallerReady(artifact), persistence.saved)
        assertEquals(emptyList<UpdateEffect>(), runner.invocations.map { it.effect })
    }

    @Test
    fun completedUpdateStateIsClearedBeforeFreshDiscoveryStarts() {
        val installedRelease = release.copy(version = "0.5.1")
        val artifact = verifiedApk(installedRelease)
        val staleStates = listOf(
            UpdateState.Available(installedRelease),
            UpdateState.Downloading(installedRelease, 1, 2),
            UpdateState.Cancelling(installedRelease, 1, 2),
            UpdateState.Verifying(DownloadedApk(installedRelease, "/cache/update.part")),
            UpdateState.InstallerReady(artifact),
            UpdateState.CheckingInstallPermission(artifact),
            UpdateState.PermissionRequired(installedRelease, artifact),
            UpdateState.LaunchRequested(artifact),
            UpdateState.Error(UpdateStage.INSTALLER, "stale", installedRelease, verifiedApk = artifact),
        )

        staleStates.forEach { stale ->
            val runner = RecordingEffectRunner()
            val persistence = MemoryUpdateStatePersistence(stale)
            val controller = UpdateController("0.5.1", runner, persistence)

            controller.start()

            assertEquals(UpdateState.Checking, controller.state)
            assertEquals(1, persistence.clearCalls)
            assertEquals(listOf(UpdateEffect.FetchReleases), runner.invocations.map { it.effect })
        }
    }

    private class RecordingEffectRunner : UpdateEffectRunner {
        val invocations = mutableListOf<Invocation>()

        override fun run(effect: UpdateEffect, emit: (UpdateEvent) -> Unit) {
            invocations += Invocation(effect, emit)
        }
    }

    private data class Invocation(
        val effect: UpdateEffect,
        val emit: (UpdateEvent) -> Unit,
    )
}
