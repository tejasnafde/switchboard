package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.reviews.PhoneReviewPill
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Review pills waiting in a chat's composer (Reviews > Work on PR, Attach,
 * Ask the agent), by chat. In memory only: the pill rides the outbox once it
 * is sent, which is durable; an unsent pill does not outlive the process.
 */
class PendingReviewPills {
    private val pills = MutableStateFlow<Map<ComposerDraftKey, PhoneReviewPill>>(emptyMap())
    val state: StateFlow<Map<ComposerDraftKey, PhoneReviewPill>> = pills.asStateFlow()

    fun get(key: ComposerDraftKey): PhoneReviewPill? = pills.value[key]

    fun set(key: ComposerDraftKey, pill: PhoneReviewPill) = pills.update { it + (key to pill) }

    fun clear(key: ComposerDraftKey) = pills.update { it - key }
}
