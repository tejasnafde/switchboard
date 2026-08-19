package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateRelease
import org.junit.Assert.assertEquals
import org.junit.Test

class ArchivePreflightPolicyTest {
    private val release = UpdateRelease("0.6.0", "https://example.test/update.apk", "abc123")
    private val installed = PackageIdentity(
        packageName = ArchivePreflightPolicy.PRODUCTION_PACKAGE,
        versionCode = 2,
        versionName = "0.5.0",
        signerSha256 = setOf(CANONICAL_SIGNER),
    )

    @Test
    fun acceptsOnlyANewerProductionPackageWithTheSameSignerAndVersionName() {
        val archive = installed.copy(versionCode = 3, versionName = "0.6.0")

        assertEquals(ArchivePreflightDecision.Accept, ArchivePreflightPolicy.evaluate(release, installed, archive))
    }

    @Test
    fun rejectsPackageSignerVersionCodeAndVersionNameMismatches() {
        assertRejected(
            ArchiveRejection.PACKAGE_NAME,
            installed.copy(packageName = "example.impostor", versionCode = 3, versionName = "0.6.0"),
        )
        assertRejected(
            ArchiveRejection.SIGNER,
            installed.copy(versionCode = 3, versionName = "0.6.0", signerSha256 = setOf("other")),
        )
        assertRejected(
            ArchiveRejection.VERSION_CODE,
            installed.copy(versionCode = 2, versionName = "0.6.0"),
        )
        assertRejected(
            ArchiveRejection.VERSION_NAME,
            installed.copy(versionCode = 3, versionName = "0.6.1"),
        )
    }

    @Test
    fun rejectsMatchingButNoncanonicalInstalledAndArchiveSigners() {
        val noncanonicalInstalled = installed.copy(signerSha256 = setOf("noncanonical"))
        val archive = noncanonicalInstalled.copy(versionCode = 3, versionName = "0.6.0")

        assertEquals(
            ArchivePreflightDecision.Reject(ArchiveRejection.SIGNER),
            ArchivePreflightPolicy.evaluate(release, noncanonicalInstalled, archive),
        )
    }

    @Test
    fun rejectionMessagesIdentifyTheActualFailedIdentityField() {
        assertEquals("Downloaded APK has the wrong package ID", ArchiveRejection.PACKAGE_NAME.installerMessage())
        assertEquals("Downloaded APK signer does not match the installed app", ArchiveRejection.SIGNER.installerMessage())
        assertEquals(
            "This update is not newer than the installed version",
            ArchiveRejection.VERSION_CODE.installerMessage(),
        )
        assertEquals("Downloaded APK version does not match the release", ArchiveRejection.VERSION_NAME.installerMessage())
    }

    private fun assertRejected(reason: ArchiveRejection, archive: PackageIdentity) {
        assertEquals(
            ArchivePreflightDecision.Reject(reason),
            ArchivePreflightPolicy.evaluate(release, installed, archive),
        )
    }

    private companion object {
        const val CANONICAL_SIGNER =
            "bc811e3712c2d57f2b6ebda54392e62ebd2a773453e50fb375e1102db901a8f6"
    }
}
