package app.switchboard.mobile.platform.update

data class PendingInstallation(
    val packageName: String,
    val baselineVersionCode: Long,
    val targetVersionCode: Long,
    val targetVersionName: String,
    val signerSha256: Set<String>,
    val requestedAtEpochMillis: Long,
)

interface PendingInstallationPersistence {
    fun load(): PendingInstallation?

    fun save(pendingInstallation: PendingInstallation)

    fun clear()
}

sealed interface PendingInstallationStatus {
    data object None : PendingInstallationStatus

    data class Awaiting(val pendingInstallation: PendingInstallation) : PendingInstallationStatus

    data class Confirmed(val pendingInstallation: PendingInstallation) : PendingInstallationStatus

    data class IdentityMismatch(val pendingInstallation: PendingInstallation) : PendingInstallationStatus
}

class PendingInstallationTracker(
    private val persistence: PendingInstallationPersistence,
) {
    fun inspect(installed: PackageIdentity): PendingInstallationStatus {
        val pending = persistence.load() ?: return PendingInstallationStatus.None
        if (installed.versionCode < pending.targetVersionCode) {
            return PendingInstallationStatus.Awaiting(pending)
        }
        if (installed.packageName != pending.packageName || installed.signerSha256 != pending.signerSha256) {
            return PendingInstallationStatus.IdentityMismatch(pending)
        }

        persistence.clear()
        return PendingInstallationStatus.Confirmed(pending)
    }
}
