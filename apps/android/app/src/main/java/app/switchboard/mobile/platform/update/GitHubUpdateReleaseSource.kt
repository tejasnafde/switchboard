package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.GitHubRelease
import app.switchboard.mobile.update.UpdateReleaseSource
import java.net.HttpURLConnection
import java.net.URL

class GitHubUpdateReleaseSource(
    private val endpoint: URL = URL(RELEASES_API),
    private val connectionFactory: (URL) -> HttpURLConnection = { url ->
        url.openConnection() as HttpURLConnection
    },
) : UpdateReleaseSource {
    override suspend fun fetchReleases(): List<GitHubRelease> {
        val connection = connectionFactory(endpoint)
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = TIMEOUT_MILLIS
            connection.readTimeout = TIMEOUT_MILLIS
            connection.setRequestProperty("Accept", "application/vnd.github+json")
            connection.setRequestProperty("User-Agent", "Switchboard-Android")

            val statusCode = connection.responseCode
            val body = if (statusCode in 200..299) {
                connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            } else {
                connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            }
            check(statusCode in 200..299) {
                "GitHub releases request failed (HTTP $statusCode)${body.errorSuffix()}"
            }
            return GitHubReleaseResponseParser.parse(body)
        } finally {
            connection.disconnect()
        }
    }

    private fun String.errorSuffix(): String {
        val compact = trim().replace(Regex("\\s+"), " ").take(200)
        return if (compact.isEmpty()) "" else ": $compact"
    }

    private companion object {
        const val RELEASES_API =
            "https://api.github.com/repos/tejasnafde/switchboard/releases?per_page=30"
        const val TIMEOUT_MILLIS = 8_000
    }
}
