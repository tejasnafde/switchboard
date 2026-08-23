package app.switchboard.mobile.domain.composer

import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn

data class ComposerDraftKey(
    val connectionId: String,
    val threadId: String,
) {
    init {
        require(connectionId.isNotBlank()) { "connection id is required" }
        require(threadId.isNotBlank()) { "thread id is required" }
    }

    val storageKey: String = "$connectionId:$threadId"

    companion object {
        fun parse(storageKey: String): ComposerDraftKey {
            val separator = storageKey.indexOf(':')
            require(separator > 0 && separator < storageKey.lastIndex) {
                "invalid composer draft key"
            }
            return ComposerDraftKey(
                storageKey.substring(0, separator),
                storageKey.substring(separator + 1),
            )
        }
    }
}

data class ComposerAttachment(
    val id: String,
    val privateUri: String,
    val mimeType: String?,
    val displayName: String,
)

data class ComposerImageSource(
    val contentUri: String,
    val mimeType: String?,
    val displayName: String,
    val privateSourcePath: String? = null,
)

data class ComposerDraft(
    val key: ComposerDraftKey,
    val text: String = "",
    val runtimeMode: String = "sandbox",
    val attachments: List<ComposerAttachment> = emptyList(),
    val editingOrigin: String? = null,
)

data class ComposerAttachmentSelection(
    val attachments: List<ComposerAttachment>,
    val rejected: List<ComposerAttachment>,
)

object ComposerAttachmentPolicy {
    fun select(
        existing: List<ComposerAttachment>,
        candidates: List<ComposerAttachment>,
    ): ComposerAttachmentSelection = ComposerAttachmentSelection(
        attachments = existing + candidates,
        rejected = emptyList(),
    )
}

object ComposerDraftPolicy {
    fun canSend(draft: ComposerDraft): Boolean =
        draft.text.isNotBlank() || draft.attachments.isNotEmpty()
}

enum class OutboxUiAction {
    Retry,
    Edit,
    Dismiss,
}

object OutboxPresentationPolicy {
    fun actions(turn: QueuedTurn): Set<OutboxUiAction> = when (turn.deliveryState) {
        OutboxDeliveryState.Pending -> setOf(OutboxUiAction.Edit)
        is OutboxDeliveryState.Ambiguous -> setOf(OutboxUiAction.Retry)
        is OutboxDeliveryState.Terminal ->
            setOf(OutboxUiAction.Retry, OutboxUiAction.Edit, OutboxUiAction.Dismiss)

        is OutboxDeliveryState.Acknowledged -> emptySet()
    }
}
