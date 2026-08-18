package app.switchboard.mobile.platform.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PendingInstallationTrackerTest {
    private val pending = PendingInstallation(
        packageName = ArchivePreflightPolicy.PRODUCTION_PACKAGE,
        baselineVersionCode = 2,
        targetVersionCode = 3,
        targetVersionName = "0.6.0",
        signerSha256 = setOf("production-signer"),
        requestedAtEpochMillis = 1234,
    )

    @Test
    fun confirmsAndClearsOnlyAfterTheProductionIdentityReachedTheTargetVersion() {
        val persistence = MemoryPendingInstallationPersistence(pending)
        val tracker = PendingInstallationTracker(persistence)
        val installed = PackageIdentity(
            packageName = pending.packageName,
            versionCode = 3,
            versionName = pending.targetVersionName,
            signerSha256 = pending.signerSha256,
        )

        assertEquals(PendingInstallationStatus.Confirmed(pending), tracker.inspect(installed))
        assertNull(persistence.pending)
    }

    @Test
    fun anUnchangedOrWronglySignedInstallIsNotReportedAsSuccessful() {
        val unchangedStore = MemoryPendingInstallationPersistence(pending)
        assertEquals(
            PendingInstallationStatus.Awaiting(pending),
            PendingInstallationTracker(unchangedStore).inspect(
                PackageIdentity(pending.packageName, 2, "0.5.0", pending.signerSha256),
            ),
        )

        val wrongSignerStore = MemoryPendingInstallationPersistence(pending)
        assertEquals(
            PendingInstallationStatus.IdentityMismatch(pending),
            PendingInstallationTracker(wrongSignerStore).inspect(
                PackageIdentity(pending.packageName, 3, "0.6.0", setOf("other")),
            ),
        )
        assertEquals(pending, wrongSignerStore.pending)
    }
}
