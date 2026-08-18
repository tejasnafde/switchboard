package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.GitHubAsset
import app.switchboard.mobile.update.GitHubRelease
import org.junit.Assert.assertEquals
import org.junit.Test

class GitHubReleaseResponseParserTest {
    @Test
    fun decodesTheReleaseListIncludingGitHubAssetDigests() {
        val releases = GitHubReleaseResponseParser.parse(
            """
            [
              {
                "tag_name": "mobile-v0.6.0",
                "draft": false,
                "prerelease": false,
                "assets": [
                  {
                    "name": "switchboard-0.6.0.apk",
                    "browser_download_url": "https://example.test/update.apk",
                    "digest": "sha256:abc123"
                  }
                ]
              }
            ]
            """.trimIndent(),
        )

        assertEquals(
            listOf(
                GitHubRelease(
                    tagName = "mobile-v0.6.0",
                    draft = false,
                    prerelease = false,
                    assets = listOf(
                        GitHubAsset(
                            name = "switchboard-0.6.0.apk",
                            downloadUrl = "https://example.test/update.apk",
                            digest = "sha256:abc123",
                        ),
                    ),
                ),
            ),
            releases,
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsASuccessfulResponseWhoseBodyIsNotAReleaseList() {
        GitHubReleaseResponseParser.parse("""{"message":"domain failure"}""")
    }
}
