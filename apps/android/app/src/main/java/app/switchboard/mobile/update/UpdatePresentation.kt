package app.switchboard.mobile.update

enum class UpdateAction {
    CHECK,
    DOWNLOAD,
    CANCEL,
    INSTALL,
    OPEN_SETTINGS,
    RETRY,
}

data class UpdatePresentation(
    val visible: Boolean,
    val title: String,
    val detail: String,
    val primaryAction: UpdateAction? = null,
    val progressFraction: Float? = null,
    val busy: Boolean = false,
) {
    companion object {
        fun from(state: UpdateState): UpdatePresentation = when (state) {
            UpdateState.Idle -> UpdatePresentation(
                visible = false,
                title = "",
                detail = "",
            )

            UpdateState.Checking,
            UpdateState.UpToDate,
            -> UpdatePresentation(
                visible = false,
                title = "",
                detail = "",
            )

            is UpdateState.Available -> UpdatePresentation(
                visible = true,
                title = "Switchboard ${state.release.version} is available",
                detail = "Download the signed APK update",
                primaryAction = UpdateAction.DOWNLOAD,
            )

            is UpdateState.Downloading -> UpdatePresentation(
                visible = true,
                title = "Downloading Switchboard ${state.release.version}",
                detail = downloadDetail(state.bytesDownloaded, state.totalBytes),
                primaryAction = UpdateAction.CANCEL,
                progressFraction = progressFraction(state.bytesDownloaded, state.totalBytes),
                busy = true,
            )

            is UpdateState.Cancelling -> UpdatePresentation(
                visible = true,
                title = "Cancelling download",
                detail = downloadDetail(state.bytesDownloaded, state.totalBytes),
                busy = true,
            )

            is UpdateState.Verifying -> UpdatePresentation(
                visible = true,
                title = "Verifying Switchboard ${state.downloadedApk.release.version}",
                detail = "Checking the downloaded APK before installation",
                busy = true,
            )

            is UpdateState.InstallerReady -> UpdatePresentation(
                visible = true,
                title = "Switchboard ${state.artifact.release.version} is ready",
                detail = "Android will ask you to confirm the replacement",
                primaryAction = UpdateAction.INSTALL,
            )

            is UpdateState.CheckingInstallPermission -> UpdatePresentation(
                visible = true,
                title = "Preparing the installer",
                detail = "Checking permission to install this update",
                busy = true,
            )

            is UpdateState.PermissionRequired -> UpdatePresentation(
                visible = true,
                title = "Allow updates from Switchboard",
                detail = "Enable installation permission, then return to continue",
                primaryAction = UpdateAction.OPEN_SETTINGS,
            )

            is UpdateState.LaunchRequested -> UpdatePresentation(
                visible = true,
                title = "Opening the Android installer",
                detail = "Confirm the update in the system installer",
                busy = true,
            )

            is UpdateState.Error -> UpdatePresentation(
                visible = true,
                title = errorTitle(state.stage),
                detail = state.message,
                primaryAction = UpdateAction.RETRY,
            )
        }

        private fun progressFraction(bytesDownloaded: Long, totalBytes: Long?): Float? {
            if (totalBytes == null || totalBytes <= 0) return null
            return (bytesDownloaded.toDouble() / totalBytes.toDouble()).coerceIn(0.0, 1.0).toFloat()
        }

        private fun downloadDetail(bytesDownloaded: Long, totalBytes: Long?): String {
            val downloaded = formatBytes(bytesDownloaded)
            return if (totalBytes != null && totalBytes > 0) {
                "$downloaded of ${formatBytes(totalBytes)}"
            } else {
                "$downloaded downloaded"
            }
        }

        private fun formatBytes(bytes: Long): String {
            val safeBytes = bytes.coerceAtLeast(0)
            val mebibyte = 1024.0 * 1024.0
            return if (safeBytes < mebibyte) {
                "${safeBytes / 1024} KB"
            } else {
                "%.1f MB".format(safeBytes / mebibyte)
            }
        }

        private fun errorTitle(stage: UpdateStage): String = when (stage) {
            UpdateStage.DISCOVERY -> "Could not check for updates"
            UpdateStage.DOWNLOAD -> "Could not download the update"
            UpdateStage.VERIFICATION -> "Update verification failed"
            UpdateStage.INSTALLER -> "Could not open the installer"
        }
    }
}
