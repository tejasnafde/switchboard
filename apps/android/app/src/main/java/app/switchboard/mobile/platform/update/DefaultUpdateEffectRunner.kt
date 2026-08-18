package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateDownloader
import app.switchboard.mobile.update.UpdateEffect
import app.switchboard.mobile.update.UpdateEvent
import app.switchboard.mobile.update.UpdateInstaller
import app.switchboard.mobile.update.UpdateReleaseSource
import app.switchboard.mobile.update.UpdateStage
import app.switchboard.mobile.update.UpdateVerifier
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

class UpdateDownloadCancelledException : IOException("Update download cancelled")

class UpdateAlreadyInProgressException : IllegalStateException("An update download is already running")

class DefaultUpdateEffectRunner(
    private val releaseSource: UpdateReleaseSource,
    private val downloader: UpdateDownloader,
    private val verifier: UpdateVerifier,
    private val installer: UpdateInstaller,
    private val executor: ExecutorService,
) : UpdateEffectRunner {
    private val downloadLock = Any()
    private var activeDownload: DownloadOperation? = null
    private val cancellationRequested = AtomicBoolean(false)

    override fun run(effect: UpdateEffect, emit: (UpdateEvent) -> Unit) {
        when (effect) {
            UpdateEffect.FetchReleases -> execute(UpdateStage.DISCOVERY, emit) {
                emit(UpdateEvent.ReleasesLoaded(await { releaseSource.fetchReleases() }))
            }

            is UpdateEffect.StartDownload -> startDownload(effect, emit)
            UpdateEffect.CancelDownload -> cancelDownload(emit)
            is UpdateEffect.VerifyDownload -> execute(UpdateStage.VERIFICATION, emit) {
                emit(UpdateEvent.VerificationSucceeded(await { verifier.verify(effect.downloadedApk) }))
            }

            UpdateEffect.CheckInstallPermission -> execute(UpdateStage.INSTALLER, emit) {
                emit(UpdateEvent.InstallPermissionChecked(installer.canRequestPackageInstalls()))
            }

            UpdateEffect.OpenUnknownSourcesSettings -> execute(UpdateStage.INSTALLER, emit) {
                installer.openUnknownSourcesSettings()
            }

            is UpdateEffect.LaunchInstaller -> execute(UpdateStage.INSTALLER, emit) {
                installer.launchInstaller(effect.artifact)
            }
        }
    }

    private fun startDownload(effect: UpdateEffect.StartDownload, emit: (UpdateEvent) -> Unit) {
        synchronized(downloadLock) {
            if (activeDownload?.finished?.count?.let { it != 0L } == true) {
                emit(UpdateEvent.Failed(UpdateStage.DOWNLOAD, UpdateAlreadyInProgressException().message.orEmpty()))
                return
            }
            cancellationRequested.set(false)
            val operation = DownloadOperation()
            operation.future = executor.submit {
                val shouldRun = synchronized(downloadLock) {
                    if (operation.cancelled) {
                        false
                    } else {
                        operation.started = true
                        true
                    }
                }
                if (!shouldRun) {
                    operation.finished.countDown()
                    return@submit
                }
                try {
                    val downloaded = await {
                        downloader.download(effect.release) { bytesDownloaded, totalBytes ->
                            emit(
                                UpdateEvent.DownloadProgress(
                                    version = effect.release.version,
                                    bytesDownloaded = bytesDownloaded,
                                    totalBytes = totalBytes,
                                ),
                            )
                        }
                    }
                    emit(UpdateEvent.DownloadCompleted(downloaded))
                } catch (_: UpdateDownloadCancelledException) {
                    if (!cancellationRequested.get()) emit(UpdateEvent.DownloadCancelled)
                } catch (failure: Throwable) {
                    if (!cancellationRequested.get()) {
                        emit(UpdateEvent.Failed(UpdateStage.DOWNLOAD, failure.updateMessage()))
                    }
                } finally {
                    operation.finished.countDown()
                }
            }
            activeDownload = operation
        }
    }

    private fun cancelDownload(emit: (UpdateEvent) -> Unit) {
        cancellationRequested.set(true)
        val operation = synchronized(downloadLock) {
            activeDownload?.also { running ->
                running.cancelled = true
                if (!running.started) running.future?.cancel(false)
            }
        }
        if (operation != null && !operation.started) operation.finished.countDown()
        try {
            downloader.cancel()
        } catch (failure: Throwable) {
            emit(UpdateEvent.Failed(UpdateStage.DOWNLOAD, failure.updateMessage()))
            return
        }

        executor.execute {
            try {
                operation?.finished?.await()
                emit(UpdateEvent.DownloadCancelled)
            } catch (_: Throwable) {
                emit(UpdateEvent.DownloadCancelled)
            }
        }
    }

    private fun execute(
        stage: UpdateStage,
        emit: (UpdateEvent) -> Unit,
        operation: () -> Unit,
    ) {
        executor.execute {
            try {
                operation()
            } catch (failure: Throwable) {
                emit(UpdateEvent.Failed(stage, failure.updateMessage()))
            }
        }
    }

    private fun <T> await(operation: suspend () -> T): T {
        val completed = CountDownLatch(1)
        var outcome: Result<T>? = null
        operation.startCoroutine(
            object : Continuation<T> {
                override val context = EmptyCoroutineContext

                override fun resumeWith(result: Result<T>) {
                    outcome = result
                    completed.countDown()
                }
            },
        )
        completed.await()
        return requireNotNull(outcome).getOrThrow()
    }

    private fun Throwable.updateMessage(): String = message?.takeIf(String::isNotBlank)
        ?: "Update operation failed"

    private class DownloadOperation {
        val finished = CountDownLatch(1)
        var future: Future<*>? = null
        var started = false
        var cancelled = false
    }
}
