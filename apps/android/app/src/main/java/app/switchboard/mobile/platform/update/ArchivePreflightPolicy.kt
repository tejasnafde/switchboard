package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateRelease

data class PackageIdentity(
    val packageName: String,
    val versionCode: Long,
    val versionName: String,
    val signerSha256: Set<String>,
)

enum class ArchiveRejection {
    PACKAGE_NAME,
    SIGNER,
    VERSION_CODE,
    VERSION_NAME,
}

sealed interface ArchivePreflightDecision {
    data object Accept : ArchivePreflightDecision

    data class Reject(val reason: ArchiveRejection) : ArchivePreflightDecision
}

object ArchivePreflightPolicy {
    const val PRODUCTION_PACKAGE = "app.switchboard.mobile"

    fun evaluate(
        release: UpdateRelease,
        installed: PackageIdentity,
        archive: PackageIdentity,
    ): ArchivePreflightDecision = when {
        installed.packageName != PRODUCTION_PACKAGE || archive.packageName != PRODUCTION_PACKAGE ->
            ArchivePreflightDecision.Reject(ArchiveRejection.PACKAGE_NAME)

        installed.signerSha256.isEmpty() || archive.signerSha256 != installed.signerSha256 ->
            ArchivePreflightDecision.Reject(ArchiveRejection.SIGNER)

        archive.versionCode <= installed.versionCode ->
            ArchivePreflightDecision.Reject(ArchiveRejection.VERSION_CODE)

        archive.versionName != release.version ->
            ArchivePreflightDecision.Reject(ArchiveRejection.VERSION_NAME)

        else -> ArchivePreflightDecision.Accept
    }
}
