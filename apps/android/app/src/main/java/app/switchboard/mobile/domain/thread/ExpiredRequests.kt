package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

const val EXPIRED_EVENT_TYPE = "request.expired"

/** Port of `expiredRequestNotice` and `REQUEST_EXPIRED` in src/shared/provider-events.ts. */
object ExpiredRequests {
    const val REFUSED = "This request has expired: the agent is no longer waiting for an answer"
    const val NO_LONGER_WAITING = "The agent is no longer waiting for an answer."

    fun notice(approval: Boolean, reason: String): String =
        if (approval) "Approval expired, nothing was approved. $reason" else "Question expired, no answer was sent. $reason"

    /** A `request.expired` event this client raises itself (recovery, a refused answer). */
    fun event(threadId: String, requestId: String, reason: String = NO_LONGER_WAITING): JsonObject = JsonObject(
        linkedMapOf(
            "type" to JsonString(EXPIRED_EVENT_TYPE),
            "threadId" to JsonString(threadId),
            "requestId" to JsonString(requestId),
            "reason" to JsonString(reason),
        ),
    )

    /** Approval and question cards still open in the feed. */
    fun openRequestIds(feed: List<FeedItem>): Set<String> = feed.mapNotNullTo(mutableSetOf()) { item ->
        when {
            item is FeedItem.Approval && item.state == "pending" -> item.requestId
            item is FeedItem.Question && item.answers == null -> item.requestId
            else -> null
        }
    }
}
