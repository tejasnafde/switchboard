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
    const val PRODUCTION_SIGNER_SHA256 =
        "bc811e3712c2d57f2b6ebda54392e62ebd2a773453e50fb375e1102db901a8f6"

    private val productionSigner = setOf(PRODUCTION_SIGNER_SHA256)

    fun evaluate(
        release: UpdateRelease,
        installed: PackageIdentity,
        archive: PackageIdentity,
    ): ArchivePreflightDecision = when {
        installed.packageName != PRODUCTION_PACKAGE || archive.packageName != PRODUCTION_PACKAGE ->
            ArchivePreflightDecision.Reject(ArchiveRejection.PACKAGE_NAME)

        installed.signerSha256 != productionSigner || archive.signerSha256 != productionSigner ->
            ArchivePreflightDecision.Reject(ArchiveRejection.SIGNER)

        archive.versionCode <= installed.versionCode ->
            ArchivePreflightDecision.Reject(ArchiveRejection.VERSION_CODE)

        archive.versionName != release.version ->
            ArchivePreflightDecision.Reject(ArchiveRejection.VERSION_NAME)

        else -> ArchivePreflightDecision.Accept
    }
}

fun ArchiveRejection.installerMessage(): String = when (this) {
    ArchiveRejection.PACKAGE_NAME -> "Downloaded APK has the wrong package ID"
    ArchiveRejection.SIGNER -> "Downloaded APK signer does not match the installed app"
    ArchiveRejection.VERSION_CODE -> "This update is not newer than the installed version"
    ArchiveRejection.VERSION_NAME -> "Downloaded APK version does not match the release"
}
