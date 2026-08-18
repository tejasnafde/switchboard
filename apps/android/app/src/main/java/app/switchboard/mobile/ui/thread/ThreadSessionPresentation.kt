package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadComposerState
import app.switchboard.mobile.data.thread.ThreadSessionControl
import app.switchboard.mobile.data.thread.ThreadSessionLoad
import app.switchboard.mobile.data.thread.ThreadSessionPlanAction
import app.switchboard.mobile.data.thread.ThreadSessionState
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.RuntimeMode

data class ThreadComposerPresentation(
    val draft: String,
    val runtimeMode: RuntimeMode,
    val submitting: Boolean,
    val interrupting: Boolean,
    val modeChanging: Boolean,
    val error: String?,
    val controlMessage: String?,
    val focusRequest: Long,
    val showInterrupt: Boolean,
) {
    val canSend: Boolean
        get() = canSendNow()

    fun canSendNow(): Boolean = draft.isNotBlank() && !submitting
}

fun ThreadSessionLoad.toUiLoadState(): ThreadLoadState = when (this) {
    is ThreadSessionLoad.Loading -> ThreadLoadState.Loading(cached)
    is ThreadSessionLoad.Ready -> ThreadLoadState.Ready(
        thread = thread,
        cached = cached,
        refreshing = refreshing,
        recoveryMessage = recoveryMessage,
    )
    is ThreadSessionLoad.Failed -> ThreadLoadState.Failed(message, cached)
}

fun ThreadSessionState.toComposerPresentation(): ThreadComposerPresentation {
    val thread = when (val value = load) {
        is ThreadSessionLoad.Loading -> value.cached
        is ThreadSessionLoad.Ready -> value.thread
        is ThreadSessionLoad.Failed -> value.cached
    }
    return composer.toPresentation(
        controlMessage = controlMessage,
        showInterrupt = thread?.status == "running",
    )
}

private fun ThreadComposerState.toPresentation(
    controlMessage: String?,
    showInterrupt: Boolean,
) = ThreadComposerPresentation(
    draft = draft,
    runtimeMode = runtimeMode,
    submitting = submitting,
    interrupting = interrupting,
    modeChanging = modeChanging,
    error = error,
    controlMessage = controlMessage,
    focusRequest = focusRequest,
    showInterrupt = showInterrupt,
)

fun ThreadUiAction.toSessionControl(): ThreadSessionControl = when (this) {
    is ThreadUiAction.Approval -> ThreadSessionControl.Approval(
        requestId,
        when (decision) {
            ThreadApprovalDecision.APPROVE -> ApprovalDecision.Approve
            ThreadApprovalDecision.DENY -> ApprovalDecision.Deny
        },
    )
    is ThreadUiAction.AnswerQuestion -> ThreadSessionControl.AnswerQuestion(requestId, answers)
    is ThreadUiAction.Plan -> ThreadSessionControl.Plan(
        planId,
        when (action) {
            ThreadPlanAction.IMPLEMENT -> ThreadSessionPlanAction.Implement
            ThreadPlanAction.ITERATE -> ThreadSessionPlanAction.Iterate
        },
    )
    is ThreadUiAction.OpenFile -> ThreadSessionControl.OpenFile(fileEditId, repoRoot, relPath)
}
