package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.DownloadedApk
import app.switchboard.mobile.update.GitHubRelease
import app.switchboard.mobile.update.UpdateDownloader
import app.switchboard.mobile.update.UpdateEffect
import app.switchboard.mobile.update.UpdateEvent
import app.switchboard.mobile.update.UpdateInstaller
import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateReleaseSource
import app.switchboard.mobile.update.UpdateVerifier
import app.switchboard.mobile.update.VerifiedApk
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultUpdateEffectRunnerTest {
    private val release = UpdateRelease("0.6.0", "https://example.test/update.apk", "abc123")

    @Test
    fun mapsPortResultsBackIntoStateMachineEvents() {
        val executor = Executors.newSingleThreadExecutor()
        val downloaded = DownloadedApk(release, "/cache/update.part")
        val verified = verifiedApk(release)
        val events = LinkedBlockingQueue<UpdateEvent>()
        val runner = DefaultUpdateEffectRunner(
            releaseSource = object : UpdateReleaseSource {
                override suspend fun fetchReleases(): List<GitHubRelease> = emptyList()
            },
            downloader = object : UpdateDownloader {
                override suspend fun download(
                    release: UpdateRelease,
                    onProgress: (Long, Long?) -> Unit,
                ): DownloadedApk {
                    onProgress(4, 10)
                    return downloaded
                }

                override fun cancel() = Unit
            },
            verifier = object : UpdateVerifier {
                override suspend fun verify(downloadedApk: DownloadedApk): VerifiedApk = verified
            },
            installer = NoOpInstaller,
            executor = executor,
        )

        try {
            runner.run(UpdateEffect.FetchReleases, events::add)
            assertEquals(UpdateEvent.ReleasesLoaded(emptyList()), events.takeWithinTimeout())

            runner.run(UpdateEffect.StartDownload(release), events::add)
            assertEquals(UpdateEvent.DownloadProgress(release.version, 4, 10), events.takeWithinTimeout())
            assertEquals(UpdateEvent.DownloadCompleted(downloaded), events.takeWithinTimeout())

            runner.run(UpdateEffect.VerifyDownload(downloaded), events::add)
            assertEquals(UpdateEvent.VerificationSucceeded(verified), events.takeWithinTimeout())
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun cancellationSignalsTheDownloaderSynchronouslyAndWaitsForItsTaskToExit() {
        val executor = Executors.newSingleThreadExecutor()
        val enteredDownload = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        val events = LinkedBlockingQueue<UpdateEvent>()
        val downloader = object : UpdateDownloader {
            override suspend fun download(
                release: UpdateRelease,
                onProgress: (Long, Long?) -> Unit,
            ): DownloadedApk {
                enteredDownload.countDown()
                cancelled.await()
                throw UpdateDownloadCancelledException()
            }

            override fun cancel() {
                cancelled.countDown()
            }
        }
        val runner = DefaultUpdateEffectRunner(
            releaseSource = EmptyReleaseSource,
            downloader = downloader,
            verifier = FailingVerifier,
            installer = NoOpInstaller,
            executor = executor,
        )

        try {
            runner.run(UpdateEffect.StartDownload(release), events::add)
            assertTrue(enteredDownload.await(2, TimeUnit.SECONDS))

            runner.run(UpdateEffect.CancelDownload, events::add)

            assertEquals(UpdateEvent.DownloadCancelled, events.takeWithinTimeout())
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun cancellationPreventsAQueuedDownloadFromStarting() {
        val executor = Executors.newSingleThreadExecutor()
        val releaseExecutor = CountDownLatch(1)
        val blockerStarted = CountDownLatch(1)
        executor.submit {
            blockerStarted.countDown()
            releaseExecutor.await()
        }
        assertTrue(blockerStarted.await(2, TimeUnit.SECONDS))
        val downloadStarted = AtomicBoolean(false)
        val events = LinkedBlockingQueue<UpdateEvent>()
        val downloader = object : UpdateDownloader {
            override suspend fun download(
                release: UpdateRelease,
                onProgress: (Long, Long?) -> Unit,
            ): DownloadedApk {
                downloadStarted.set(true)
                return DownloadedApk(release, "/cache/should-not-exist.part")
            }

            override fun cancel() = Unit
        }
        val runner = DefaultUpdateEffectRunner(
            releaseSource = EmptyReleaseSource,
            downloader = downloader,
            verifier = FailingVerifier,
            installer = NoOpInstaller,
            executor = executor,
        )

        try {
            runner.run(UpdateEffect.StartDownload(release), events::add)
            runner.run(UpdateEffect.CancelDownload, events::add)
            releaseExecutor.countDown()

            assertEquals(UpdateEvent.DownloadCancelled, events.takeWithinTimeout())
            assertFalse(downloadStarted.get())
        } finally {
            releaseExecutor.countDown()
            executor.shutdownNow()
        }
    }

    private fun LinkedBlockingQueue<UpdateEvent>.takeWithinTimeout(): UpdateEvent =
        poll(2, TimeUnit.SECONDS) ?: error("Timed out waiting for update event")

    private object EmptyReleaseSource : UpdateReleaseSource {
        override suspend fun fetchReleases(): List<GitHubRelease> = emptyList()
    }

    private object FailingVerifier : UpdateVerifier {
        override suspend fun verify(downloadedApk: DownloadedApk): VerifiedApk = error("unused")
    }

    private object NoOpInstaller : UpdateInstaller {
        override fun canRequestPackageInstalls(): Boolean = true

        override fun openUnknownSourcesSettings() = Unit

        override fun launchInstaller(artifact: VerifiedApk) = Unit
    }
}
