package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadComposerState
import app.switchboard.mobile.data.thread.ThreadSessionControl
import app.switchboard.mobile.data.thread.ThreadSessionLoad
import app.switchboard.mobile.data.thread.ThreadSessionPlanAction
import app.switchboard.mobile.data.thread.ThreadSessionState
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.thread.HeldTurnActions
import app.switchboard.mobile.domain.thread.QueueToggle
import app.switchboard.mobile.domain.thread.TurnDeliveryPolicy

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
    val attachments: List<ComposerAttachment> = emptyList(),
    val editingOrigin: String? = null,
    val modelLabel: String? = null,
    /** Steer/queue chip for the next send; null when idle or the choice does not apply. */
    val queueToggle: QueueToggle? = null,
    /** Replaces the idle placeholder while a turn runs. */
    val runningPlaceholder: String? = null,
) {
    val canSend: Boolean
        get() = canSendNow()

    fun canSendNow(): Boolean = (draft.isNotBlank() || attachments.isNotEmpty()) && !submitting
}

/** Messages the backend holds until the running turn ends, as the feed shows them. */
data class ThreadHeldPresentation(
    val messageIds: Set<String> = emptySet(),
    val actions: HeldTurnActions = TurnDeliveryPolicy.heldTurnActions(null),
    val errors: Map<String, String> = emptyMap(),
    val busy: Set<String> = emptySet(),
)

fun ThreadSessionState.toHeldPresentation(): ThreadHeldPresentation {
    val thread = when (val value = load) {
        is ThreadSessionLoad.Loading -> value.cached
        is ThreadSessionLoad.Ready -> value.thread
        is ThreadSessionLoad.Failed -> value.cached
    }
    // Only a backend that can act on a held message gets its controls.
    if (!followUp.canControlHeld || thread == null) return ThreadHeldPresentation()
    return ThreadHeldPresentation(
        messageIds = thread.heldTurns,
        actions = TurnDeliveryPolicy.heldTurnActions(thread.provider),
        errors = followUp.heldErrors,
        busy = followUp.heldBusy,
    )
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
    val running = thread?.status == "running"
    val provider = thread?.provider
    val toggle = if (running && followUp.canQueue && TurnDeliveryPolicy.canSteer(provider)) {
        TurnDeliveryPolicy.queueToggle(followUp.preferred, composer.flipNextDelivery)
    } else {
        null
    }
    return composer.toPresentation(
        controlMessage = controlMessage,
        showInterrupt = running,
        modelLabel = thread?.resolvedModel,
    ).copy(
        queueToggle = toggle,
        runningPlaceholder = if (running) TurnDeliveryPolicy.runningPlaceholder(provider, toggle?.queues == true) else null,
    )
}

private fun ThreadComposerState.toPresentation(
    controlMessage: String?,
    showInterrupt: Boolean,
    modelLabel: String?,
) = ThreadComposerPresentation(
    draft = draft,
    runtimeMode = runtimeMode,
    modelLabel = modelLabel,
    submitting = submitting,
    interrupting = interrupting,
    modeChanging = modeChanging,
    error = error,
    controlMessage = controlMessage,
    focusRequest = focusRequest,
    showInterrupt = showInterrupt,
    attachments = attachments,
    editingOrigin = editingOrigin,
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
