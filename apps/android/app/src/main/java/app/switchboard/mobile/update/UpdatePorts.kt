package app.switchboard.mobile.update

interface UpdateReleaseSource {
    suspend fun fetchReleases(): List<GitHubRelease>
}

interface UpdateDownloader {
    suspend fun download(
        release: UpdateRelease,
        onProgress: (bytesDownloaded: Long, totalBytes: Long?) -> Unit,
    ): DownloadedApk

    fun cancel()
}

interface UpdateVerifier {
    suspend fun verify(downloadedApk: DownloadedApk): VerifiedApk
}

interface UpdateInstaller {
    fun canRequestPackageInstalls(): Boolean

    fun openUnknownSourcesSettings()

    fun launchInstaller(artifact: VerifiedApk)
}
