package app.switchboard.mobile.ui.update

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import app.switchboard.mobile.ui.components.InlineStatus
import app.switchboard.mobile.ui.components.InlineStatusProgress
import app.switchboard.mobile.ui.components.StatusTone
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateState

@Composable
fun UpdateSurface(
    state: UpdateState,
    onAction: (UpdateAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val presentation = UpdateSurfacePresentation.from(state) ?: return

    InlineStatus(
        message = presentation.message,
        detail = presentation.detail.takeIf {
            presentation.placement == UpdateSurfacePlacement.ReservedBanner
        },
        tone = when (state) {
            is UpdateState.Error -> StatusTone.ERROR
            is UpdateState.PermissionRequired -> StatusTone.WARNING
            is UpdateState.InstallerReady -> StatusTone.SUCCESS
            else -> StatusTone.INFO
        },
        progress = when {
            !presentation.busy -> InlineStatusProgress.None
            presentation.progressFraction != null -> {
                InlineStatusProgress.Determinate(presentation.progressFraction)
            }
            else -> InlineStatusProgress.Indeterminate
        },
        actionLabel = presentation.actionLabel,
        onAction = presentation.action?.let { action -> { onAction(action) } },
        modifier = modifier,
    )
}
