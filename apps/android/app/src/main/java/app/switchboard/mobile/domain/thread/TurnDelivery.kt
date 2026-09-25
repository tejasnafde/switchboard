package app.switchboard.mobile.domain.thread

/**
 * Steer or queue a message sent while the agent works. Ported from
 * `src/shared/turn-delivery.ts` and `apps/mobile/src/lib/held-turns.ts`;
 * keep them in sync.
 */
enum class TurnDelivery(val wire: String) {
    Steer("steer"),
    Queue("queue"),
}

/** A message the backend holds until the running turn ends; `messageId` is its user row id. */
data class QueuedTurnSummary(val messageId: String, val text: String)

sealed interface QueuedTurnActionResult {
    /** `text` is what the user typed, for putting back in the composer on cancel. */
    data class Done(val text: String) : QueuedTurnActionResult
    data class Refused(val message: String) : QueuedTurnActionResult
}

data class QueueToggle(
    /** The next send waits for the running turn. */
    val queues: Boolean,
    val label: String,
    val accessibilityLabel: String,
)

data class HeldTurnActions(
    val canPromote: Boolean,
    /** Shown instead of the default hint when Send now is unavailable. */
    val hint: String,
)

object TurnDeliveryPolicy {
    /** Per-device preference key, the same name as the desktop settings key. */
    const val FOLLOW_UP_DEFAULT_KEY = "chat.followUpDefault"

    /** The backend holds a `delivery: queue` message itself. */
    const val QUEUE_CAPABILITY = "turn_queue_v1"

    /** turn.queued / turn.dequeued plus list, promote and cancel. */
    const val QUEUE_CONTROLS_CAPABILITY = "turn_queue_controls_v1"

    fun canSteer(provider: String?): Boolean = provider != "opencode" && provider != "terminal"

    /** Anything but an explicit `queue` means steer, which is what a send always did. */
    fun parseFollowUpDefault(value: String?): TurnDelivery =
        if (value == TurnDelivery.Queue.wire) TurnDelivery.Queue else TurnDelivery.Steer

    fun followUpDelivery(preferred: TurnDelivery, alternate: Boolean): TurnDelivery = when {
        !alternate -> preferred
        preferred == TurnDelivery.Steer -> TurnDelivery.Queue
        else -> TurnDelivery.Steer
    }

    /**
     * The `delivery` a send asks the backend for, or null for a plain send.
     * Only a mid-turn send that should wait says `queue`: the user picked it,
     * or the provider cannot steer. Absent means steer, as on every client.
     */
    fun requestedDelivery(
        provider: String?,
        running: Boolean,
        preferred: TurnDelivery,
        flipped: Boolean,
    ): TurnDelivery? {
        if (!running) return null
        val queues = followUpDelivery(preferred, flipped) == TurnDelivery.Queue || !canSteer(provider)
        return if (queues) TurnDelivery.Queue else null
    }

    /** The chip above the composer while a turn runs; `flipped` is the one-send override. */
    fun queueToggle(preferred: TurnDelivery, flipped: Boolean): QueueToggle {
        val queues = followUpDelivery(preferred, flipped) == TurnDelivery.Queue
        return if (preferred == TurnDelivery.Steer) {
            QueueToggle(
                queues = queues,
                label = if (queues) "Sends after this turn" else "Steering the running turn · tap to queue",
                accessibilityLabel = "Send after this turn instead of steering it",
            )
        } else {
            QueueToggle(
                queues = queues,
                label = if (queues) "Sends after this turn · tap to steer" else "Steering the running turn",
                accessibilityLabel = "Steer the running turn instead of queueing",
            )
        }
    }

    fun runningPlaceholder(provider: String?, queues: Boolean): String = when {
        !canSteer(provider) || queues -> "Queue a follow-up…"
        else -> "Steer the agent…"
    }

    fun promoteUnavailableReason(provider: String?): String? =
        if (canSteer(provider)) null else "OpenCode cannot take a message mid-turn, so this waits for the turn to end."

    fun heldTurnActions(provider: String?): HeldTurnActions {
        val blocked = promoteUnavailableReason(provider)
        return HeldTurnActions(canPromote = blocked == null, hint = blocked ?: "Runs after this turn")
    }

    /** The held message id a feed row shows, whether the row came live or from history (`h-`). */
    fun heldMessageId(held: Set<String>, rowId: String): String? = when {
        rowId in held -> rowId
        rowId.startsWith("h-") && rowId.removePrefix("h-") in held -> rowId.removePrefix("h-")
        else -> null
    }
}
