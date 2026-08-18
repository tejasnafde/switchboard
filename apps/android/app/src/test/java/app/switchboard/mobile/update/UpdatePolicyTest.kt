package app.switchboard.mobile.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    @Test
    fun comparesEveryNumericVersionSegment() {
        assertTrue(UpdatePolicy.isNewer("1.10.0", "1.9.0"))
        assertTrue(UpdatePolicy.isNewer("1.14.0.1", "1.14.0"))
        assertFalse(UpdatePolicy.isNewer("1.2", "1.2.0"))
        assertFalse(UpdatePolicy.isNewer("0.1.9", "0.2.0"))
    }

    @Test
    fun malformedSegmentsBecomeZeroWithoutThrowing() {
        assertFalse(UpdatePolicy.isNewer("not-a-version", "0.2.0"))
        assertTrue(UpdatePolicy.isNewer("0.2.0", "not-a-version"))
    }

    @Test
    fun selectsTheHighestPublishedMobileReleaseWithAnApkRegardlessOfApiOrder() {
        val selected = UpdatePolicy.selectAvailableRelease(
            releases = listOf(
                release("v9.0.0", apk = true),
                release("mobile-v0.8.0", apk = true, draft = true),
                release("mobile-v0.7.0", apk = false),
                release("mobile-v0.6.0", apk = true),
                release("mobile-v0.10.0", apk = true),
                release("mobile-v0.5.1", apk = true),
            ),
            currentVersion = "0.5.0",
        )

        assertEquals("0.10.0", selected?.version)
        assertEquals("https://example.test/switchboard.apk", selected?.apkUrl)
    }

    @Test
    fun ignoresMalformedMobileVersionTagsInsteadOfTreatingThemAsANewerRelease() {
        val selected = UpdatePolicy.selectAvailableRelease(
            releases = listOf(
                release("mobile-v999.invalid", apk = true),
                release("mobile-v0.6.0", apk = true),
            ),
            currentVersion = "0.5.0",
        )

        assertEquals("0.6.0", selected?.version)
    }

    @Test
    fun returnsNoReleaseWhenTheCandidateIsNotNewer() {
        assertNull(
            UpdatePolicy.selectAvailableRelease(
                releases = listOf(release("mobile-v0.5.0", apk = true)),
                currentVersion = "0.5.0",
            ),
        )
    }

    private fun release(
        tag: String,
        apk: Boolean,
        draft: Boolean = false,
    ) = GitHubRelease(
        tagName = tag,
        draft = draft,
        prerelease = false,
        assets = if (apk) {
            listOf(GitHubAsset("switchboard.apk", "https://example.test/switchboard.apk"))
        } else {
            listOf(GitHubAsset("switchboard.zip", "https://example.test/switchboard.zip"))
        },
    )
}
