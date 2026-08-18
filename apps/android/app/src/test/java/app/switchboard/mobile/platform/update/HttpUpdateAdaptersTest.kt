package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateRelease
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpUpdateAdaptersTest {
    @Test
    fun githubSourceParsesEverySuccessful2xxBodyAndUsesEightSecondTimeouts() {
        val connection = StubHttpConnection(
            statusCode = 201,
            body = """
                [{"tag_name":"mobile-v0.6.0","draft":false,"prerelease":false,"assets":[]}]
            """.trimIndent(),
        )
        val source = GitHubUpdateReleaseSource(
            endpoint = URL("https://example.test/releases"),
            connectionFactory = { connection },
        )

        val releases = runSuspendTest { source.fetchReleases() }

        assertEquals("mobile-v0.6.0", releases.single().tagName)
        assertEquals(8_000, connection.connectTimeout)
        assertEquals(8_000, connection.readTimeout)
        assertTrue(connection.disconnected)
    }

    @Test
    fun downloaderResumesAValidPartialResponseAndReportsAbsoluteProgress() {
        val directory = createTempDirectory(prefix = "switchboard-updates-").toFile()
        val release = UpdateRelease("0.6.0", "https://example.test/update.apk", "abc123")
        val connection = StubHttpConnection(
            statusCode = 206,
            body = "board",
            contentRange = "bytes 6-10/11",
        )
        val downloader = HttpUpdateDownloader(directory) { connection }
        downloader.partFileFor(release).writeText("switch")
        val progress = mutableListOf<Pair<Long, Long?>>()

        try {
            val downloaded = runSuspendTest {
                downloader.download(release) { bytes, total -> progress += bytes to total }
            }

            assertEquals("switchboard", File(downloaded.filePath).readText())
            assertEquals(11L to 11L, progress.last())
            assertEquals("bytes=6-", connection.getRequestProperty("Range"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun partialFilesAreKeyedByTheFullReleaseIdentityAndStaleFilesAreDiscarded() {
        val directory = createTempDirectory(prefix = "switchboard-updates-").toFile()
        val original = UpdateRelease("0.6.0", "https://example.test/update.apk", "digest-one")
        val replacement = original.copy(apkUrl = "https://mirror.test/update.apk", expectedSha256 = "digest-two")
        val connection = StubHttpConnection(statusCode = 200, body = "replacement")
        val downloader = HttpUpdateDownloader(directory) { connection }
        val stalePart = downloader.partFileFor(original)
        stalePart.writeText("stale")

        try {
            assertTrue(stalePart != downloader.partFileFor(replacement))
            runSuspendTest { downloader.download(replacement) { _, _ -> } }
            assertTrue(!stalePart.exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    private class StubHttpConnection(
        private val statusCode: Int,
        private val body: String,
        private val contentRange: String? = null,
    ) : HttpURLConnection(URL("https://example.test")) {
        var disconnected = false
            private set

        override fun getResponseCode(): Int = statusCode

        override fun getInputStream(): InputStream = ByteArrayInputStream(body.toByteArray())

        override fun getErrorStream(): InputStream = ByteArrayInputStream(body.toByteArray())

        override fun getContentLengthLong(): Long = body.toByteArray().size.toLong()

        override fun getHeaderField(name: String?): String? =
            if (name.equals("Content-Range", ignoreCase = true)) contentRange else super.getHeaderField(name)

        override fun disconnect() {
            disconnected = true
        }

        override fun usingProxy(): Boolean = false

        override fun connect() = Unit
    }
}
