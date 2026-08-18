package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.DownloadedApk
import app.switchboard.mobile.update.UpdateDownloader
import app.switchboard.mobile.update.UpdateRelease
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class HttpUpdateDownloader(
    private val updatesDirectory: File,
    private val connectionFactory: (URL) -> HttpURLConnection = { url ->
        url.openConnection() as HttpURLConnection
    },
) : UpdateDownloader {
    private val active = AtomicBoolean(false)
    private val cancellationRequested = AtomicBoolean(false)
    private val currentConnection = AtomicReference<HttpURLConnection?>()

    override suspend fun download(
        release: UpdateRelease,
        onProgress: (bytesDownloaded: Long, totalBytes: Long?) -> Unit,
    ): DownloadedApk {
        if (!active.compareAndSet(false, true)) throw UpdateAlreadyInProgressException()
        cancellationRequested.set(false)
        check(updatesDirectory.exists() || updatesDirectory.mkdirs()) {
            "Could not create the update cache"
        }
        val partFile = partFileFor(release)

        try {
            discardStaleParts(partFile)
            ensureNotCancelled(partFile)
            val existingBytes = partFile.takeIf(File::isFile)?.length() ?: 0L
            val connection = connectionFactory(URL(release.apkUrl))
            currentConnection.set(connection)
            connection.requestMethod = "GET"
            connection.connectTimeout = DOWNLOAD_TIMEOUT_MILLIS
            connection.readTimeout = DOWNLOAD_TIMEOUT_MILLIS
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive")
            if (existingBytes > 0) connection.setRequestProperty("Range", "bytes=$existingBytes-")

            val plan = DownloadResponsePolicy.plan(
                statusCode = connection.responseCode,
                existingBytes = existingBytes,
                contentLength = connection.contentLengthLong,
                contentRange = connection.getHeaderField("Content-Range"),
            )
            var downloadedBytes = plan.startingBytes
            onProgress(downloadedBytes, plan.totalBytes)

            connection.inputStream.buffered().use { input ->
                FileOutputStream(partFile, plan.append).use { fileOutput ->
                    BufferedOutputStream(fileOutput).use { output ->
                        val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
                        while (true) {
                            ensureNotCancelled(partFile)
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            downloadedBytes += read
                            onProgress(downloadedBytes, plan.totalBytes)
                        }
                        output.flush()
                        fileOutput.fd.sync()
                    }
                }
            }
            ensureNotCancelled(partFile)
            return DownloadedApk(release, partFile.absolutePath)
        } catch (failure: Throwable) {
            if (cancellationRequested.get()) {
                deletePart(partFile)
                throw UpdateDownloadCancelledException()
            }
            throw failure
        } finally {
            currentConnection.getAndSet(null)?.disconnect()
            active.set(false)
        }
    }

    override fun cancel() {
        cancellationRequested.set(true)
        currentConnection.get()?.disconnect()
        if (!active.get()) {
            updatesDirectory.listFiles { file -> file.isFile && file.name.endsWith(PART_SUFFIX) }
                .orEmpty()
                .forEach(::deletePart)
        }
    }

    internal fun partFileFor(release: UpdateRelease): File {
        val safeVersion = release.version.map { character ->
            if (character.isLetterOrDigit() || character == '.' || character == '-' || character == '_') {
                character
            } else {
                '_'
            }
        }.joinToString(separator = "").ifEmpty { "unknown" }
        val identity = UpdateDigest.sha256(
            "${release.version}\u0000${release.apkUrl}\u0000${release.expectedSha256.orEmpty()}",
        ).take(12)
        return File(updatesDirectory, "switchboard-$safeVersion-$identity.apk$PART_SUFFIX")
    }

    private fun discardStaleParts(currentPart: File) {
        updatesDirectory.listFiles { file ->
            file.isFile && file.name.endsWith(PART_SUFFIX) && file != currentPart
        }.orEmpty().forEach(UpdateStaging::discard)
    }

    private fun ensureNotCancelled(partFile: File) {
        if (!cancellationRequested.get()) return
        deletePart(partFile)
        throw UpdateDownloadCancelledException()
    }

    private fun deletePart(file: File) {
        try {
            UpdateStaging.discard(file)
        } catch (failure: IllegalStateException) {
            throw IOException(failure.message, failure)
        }
    }

    private companion object {
        const val PART_SUFFIX = ".part"
        const val DOWNLOAD_TIMEOUT_MILLIS = 15_000
        const val DOWNLOAD_BUFFER_BYTES = 64 * 1024
    }
}
