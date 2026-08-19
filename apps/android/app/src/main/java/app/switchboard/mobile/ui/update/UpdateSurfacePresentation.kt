package app.switchboard.mobile.ui.update

import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdatePresentation
import app.switchboard.mobile.update.UpdateState

enum class UpdateSurfacePlacement {
    Snackbar,
    ReservedBanner,
}

data class UpdateSurfacePresentation(
    val message: String,
    val detail: String,
    val action: UpdateAction?,
    val actionLabel: String?,
    val progressFraction: Float?,
    val busy: Boolean,
    val placement: UpdateSurfacePlacement,
) {
    val snackbarMessage: String
        get() = listOf(message, detail)
            .filter(String::isNotBlank)
            .distinct()
            .joinToString("\n")

    companion object {
        fun from(state: UpdateState): UpdateSurfacePresentation? {
            val presentation = UpdatePresentation.from(state)
            if (!presentation.visible) return null
            return UpdateSurfacePresentation(
                message = presentation.title,
                detail = presentation.detail,
                action = presentation.primaryAction,
                actionLabel = presentation.primaryAction?.surfaceLabel,
                progressFraction = presentation.progressFraction,
                busy = presentation.busy,
                placement = when (state) {
                    is UpdateState.InstallerReady,
                    is UpdateState.PermissionRequired,
                    is UpdateState.Downloading,
                    is UpdateState.Cancelling,
                    is UpdateState.Verifying,
                    is UpdateState.CheckingInstallPermission,
                    is UpdateState.LaunchRequested,
                    -> UpdateSurfacePlacement.ReservedBanner

                    else -> UpdateSurfacePlacement.Snackbar
                },
            )
        }
    }
}

internal val UpdateAction.surfaceLabel: String
    get() = when (this) {
        UpdateAction.CHECK -> "Check again"
        UpdateAction.DOWNLOAD -> "Download"
        UpdateAction.CANCEL -> "Cancel"
        UpdateAction.INSTALL -> "Install"
        UpdateAction.OPEN_SETTINGS -> "Open settings"
        UpdateAction.RETRY -> "Retry"
    }
