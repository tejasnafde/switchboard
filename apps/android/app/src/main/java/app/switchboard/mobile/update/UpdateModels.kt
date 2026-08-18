package app.switchboard.mobile.update

data class GitHubAsset(
    val name: String,
    val downloadUrl: String,
    val digest: String? = null,
)

data class GitHubRelease(
    val tagName: String,
    val draft: Boolean,
    val prerelease: Boolean,
    val assets: List<GitHubAsset>,
)

data class UpdateRelease(
    val version: String,
    val apkUrl: String,
    val expectedSha256: String? = null,
)

data class DownloadedApk(
    val release: UpdateRelease,
    val filePath: String,
)

data class VerifiedApk(
    val release: UpdateRelease,
    val filePath: String,
    val contentUri: String,
)

enum class UpdateStage {
    DISCOVERY,
    DOWNLOAD,
    VERIFICATION,
    INSTALLER,
}

sealed interface UpdateState {
    data object Idle : UpdateState

    data object Checking : UpdateState

    data object UpToDate : UpdateState

    data class Available(val release: UpdateRelease) : UpdateState

    data class Downloading(
        val release: UpdateRelease,
        val bytesDownloaded: Long,
        val totalBytes: Long?,
    ) : UpdateState

    data class Cancelling(
        val release: UpdateRelease,
        val bytesDownloaded: Long,
        val totalBytes: Long?,
    ) : UpdateState

    data class Verifying(val downloadedApk: DownloadedApk) : UpdateState

    data class InstallerReady(val artifact: VerifiedApk) : UpdateState

    data class CheckingInstallPermission(val artifact: VerifiedApk) : UpdateState

    data class PermissionRequired(
        val release: UpdateRelease,
        val artifact: VerifiedApk,
    ) : UpdateState

    data class LaunchRequested(val artifact: VerifiedApk) : UpdateState

    data class Error(
        val stage: UpdateStage,
        val message: String,
        val release: UpdateRelease? = null,
        val downloadedApk: DownloadedApk? = null,
        val verifiedApk: VerifiedApk? = null,
    ) : UpdateState
}

sealed interface UpdateEvent {
    data object CheckRequested : UpdateEvent

    data class ReleasesLoaded(val releases: List<GitHubRelease>) : UpdateEvent

    data object DownloadRequested : UpdateEvent

    data class DownloadProgress(
        val version: String,
        val bytesDownloaded: Long,
        val totalBytes: Long?,
    ) : UpdateEvent

    data object CancelRequested : UpdateEvent

    data object DownloadCancelled : UpdateEvent

    data class DownloadCompleted(val downloadedApk: DownloadedApk) : UpdateEvent

    data class VerificationSucceeded(val artifact: VerifiedApk) : UpdateEvent

    data object InstallRequested : UpdateEvent

    data class InstallPermissionChecked(val granted: Boolean) : UpdateEvent

    data object OpenPermissionSettingsRequested : UpdateEvent

    data object PermissionSettingsReturned : UpdateEvent

    data class Failed(val stage: UpdateStage, val message: String) : UpdateEvent

    data object RetryRequested : UpdateEvent
}

sealed interface UpdateEffect {
    data object FetchReleases : UpdateEffect

    data class StartDownload(val release: UpdateRelease) : UpdateEffect

    data object CancelDownload : UpdateEffect

    data class VerifyDownload(val downloadedApk: DownloadedApk) : UpdateEffect

    data object CheckInstallPermission : UpdateEffect

    data object OpenUnknownSourcesSettings : UpdateEffect

    data class LaunchInstaller(val artifact: VerifiedApk) : UpdateEffect
}

data class UpdateTransition(
    val state: UpdateState,
    val effect: UpdateEffect? = null,
)
