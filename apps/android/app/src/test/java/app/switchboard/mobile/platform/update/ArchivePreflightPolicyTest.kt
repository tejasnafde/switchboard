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
        signerSha256 = setOf("production-signer"),
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

    private fun assertRejected(reason: ArchiveRejection, archive: PackageIdentity) {
        assertEquals(
            ArchivePreflightDecision.Reject(reason),
            ArchivePreflightPolicy.evaluate(release, installed, archive),
        )
    }
}
