package app.switchboard.mobile.update

class UpdateStateMachine(
    private val currentVersion: String,
    initialState: UpdateState = UpdateState.Idle,
) {
    var state: UpdateState = initialState
        private set

    @Synchronized
    fun restore(restoredState: UpdateState) {
        state = restoredState
    }

    @Synchronized
    fun dispatch(event: UpdateEvent): UpdateTransition {
        val transition = reduce(state, event)
        state = transition.state
        return transition
    }

    private fun reduce(current: UpdateState, event: UpdateEvent): UpdateTransition = when (event) {
        UpdateEvent.CheckRequested -> when (current) {
            UpdateState.Idle,
            UpdateState.UpToDate,
            -> transition(UpdateState.Checking, UpdateEffect.FetchReleases)

            else -> unchanged(current)
        }

        is UpdateEvent.ReleasesLoaded -> if (current == UpdateState.Checking) {
            val release = UpdatePolicy.selectAvailableRelease(event.releases, currentVersion)
            transition(release?.let(UpdateState::Available) ?: UpdateState.UpToDate)
        } else {
            unchanged(current)
        }

        UpdateEvent.DownloadRequested -> if (current is UpdateState.Available) {
            transition(
                UpdateState.Downloading(current.release, bytesDownloaded = 0, totalBytes = null),
                UpdateEffect.StartDownload(current.release),
            )
        } else {
            unchanged(current)
        }

        is UpdateEvent.DownloadProgress -> when {
            current !is UpdateState.Downloading -> unchanged(current)
            current.release.version != event.version -> unchanged(current)
            else -> transition(
                current.copy(
                    bytesDownloaded = event.bytesDownloaded.coerceAtLeast(0),
                    totalBytes = event.totalBytes?.coerceAtLeast(0),
                ),
            )
        }

        UpdateEvent.CancelRequested -> if (current is UpdateState.Downloading) {
            transition(
                UpdateState.Cancelling(
                    release = current.release,
                    bytesDownloaded = current.bytesDownloaded,
                    totalBytes = current.totalBytes,
                ),
                UpdateEffect.CancelDownload,
            )
        } else {
            unchanged(current)
        }

        UpdateEvent.DownloadCancelled -> if (current is UpdateState.Cancelling) {
            transition(UpdateState.Available(current.release))
        } else {
            unchanged(current)
        }

        is UpdateEvent.DownloadCompleted -> when {
            current !is UpdateState.Downloading -> unchanged(current)
            current.release != event.downloadedApk.release -> unchanged(current)
            else -> transition(
                UpdateState.Verifying(event.downloadedApk),
                UpdateEffect.VerifyDownload(event.downloadedApk),
            )
        }

        is UpdateEvent.VerificationSucceeded -> when {
            current !is UpdateState.Verifying -> unchanged(current)
            current.downloadedApk.release != event.artifact.release -> unchanged(current)
            else -> transition(UpdateState.InstallerReady(event.artifact))
        }

        UpdateEvent.InstallRequested -> if (current is UpdateState.InstallerReady) {
            transition(
                UpdateState.CheckingInstallPermission(current.artifact),
                UpdateEffect.CheckInstallPermission,
            )
        } else {
            unchanged(current)
        }

        is UpdateEvent.InstallPermissionChecked -> if (current is UpdateState.CheckingInstallPermission) {
            if (event.granted) {
                transition(
                    UpdateState.LaunchRequested(current.artifact),
                    UpdateEffect.LaunchInstaller(current.artifact),
                )
            } else {
                transition(UpdateState.PermissionRequired(current.artifact.release, current.artifact))
            }
        } else {
            unchanged(current)
        }

        UpdateEvent.OpenPermissionSettingsRequested -> if (current is UpdateState.PermissionRequired) {
            transition(current, UpdateEffect.OpenUnknownSourcesSettings)
        } else {
            unchanged(current)
        }

        UpdateEvent.PermissionSettingsReturned -> if (current is UpdateState.PermissionRequired) {
            transition(
                UpdateState.CheckingInstallPermission(current.artifact),
                UpdateEffect.CheckInstallPermission,
            )
        } else {
            unchanged(current)
        }

        is UpdateEvent.Failed -> transition(errorState(current, event))

        UpdateEvent.RetryRequested -> retry(current)
    }

    private fun errorState(current: UpdateState, event: UpdateEvent.Failed): UpdateState.Error {
        val release = when (current) {
            is UpdateState.Available -> current.release
            is UpdateState.Downloading -> current.release
            is UpdateState.Cancelling -> current.release
            is UpdateState.Verifying -> current.downloadedApk.release
            is UpdateState.InstallerReady -> current.artifact.release
            is UpdateState.CheckingInstallPermission -> current.artifact.release
            is UpdateState.PermissionRequired -> current.release
            is UpdateState.LaunchRequested -> current.artifact.release
            else -> null
        }
        val downloadedApk = (current as? UpdateState.Verifying)?.downloadedApk
        val verifiedApk = when (current) {
            is UpdateState.InstallerReady -> current.artifact
            is UpdateState.CheckingInstallPermission -> current.artifact
            is UpdateState.PermissionRequired -> current.artifact
            is UpdateState.LaunchRequested -> current.artifact
            else -> null
        }
        return UpdateState.Error(
            stage = event.stage,
            message = event.message,
            release = release,
            downloadedApk = downloadedApk,
            verifiedApk = verifiedApk,
        )
    }

    private fun retry(current: UpdateState): UpdateTransition {
        if (current !is UpdateState.Error) return unchanged(current)

        return when (current.stage) {
            UpdateStage.DISCOVERY -> transition(UpdateState.Checking, UpdateEffect.FetchReleases)
            UpdateStage.DOWNLOAD -> current.release?.let { release ->
                transition(
                    UpdateState.Downloading(release, bytesDownloaded = 0, totalBytes = null),
                    UpdateEffect.StartDownload(release),
                )
            } ?: unchanged(current)

            UpdateStage.VERIFICATION -> current.release?.let { release ->
                transition(
                    UpdateState.Downloading(release, bytesDownloaded = 0, totalBytes = null),
                    UpdateEffect.StartDownload(release),
                )
            } ?: unchanged(current)

            UpdateStage.INSTALLER -> current.verifiedApk?.let { artifact ->
                transition(UpdateState.InstallerReady(artifact))
            } ?: unchanged(current)
        }
    }

    private fun transition(
        state: UpdateState,
        effect: UpdateEffect? = null,
    ) = UpdateTransition(state, effect)

    private fun unchanged(state: UpdateState) = UpdateTransition(state)
}
