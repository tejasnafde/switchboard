package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * An agent's pull request write card (`hostWrite` on `request.opened`), as
 * far as a phone answers it: approved as drafted, with the resolve choice for
 * a reply and the verdict for a review. The rules port
 * `src/shared/host-write-phone.ts`; the backend re-checks every answer.
 */
data class HostWriteCard(
    val action: String,
    val host: String,
    val prLabel: String,
    val location: String?,
    val suggestResolve: Boolean,
    val draft: Boolean,
    val lineRange: Pair<Long, Long>?,
    val review: HostWriteReview?,
    /** The payload as it arrived, so the thread snapshot keeps it whole. */
    val raw: JsonObject,
)

data class HostWriteReview(
    val summary: String,
    val commentCount: Int,
    val verdicts: List<String>,
)

/** What an approval sends as the 4th argument of `provider:respond-to-request`. */
data class HostWriteResponse(val resolve: Boolean? = null, val verdict: String? = null) {
    fun toJson(): JsonObject = JsonObject(
        linkedMapOf<String, JsonValue>().apply {
            resolve?.let { put("resolve", JsonBoolean(it)) }
            verdict?.let { put("verdict", JsonString(it)) }
        },
    )
}

data class HostWriteButton(
    val id: String,
    val label: String,
    /** The button a tap should land on. A review has none: the verdict is the user's. */
    val primary: Boolean,
    val response: HostWriteResponse,
    /** Why it cannot go as drafted (edit on the desktop), or null. */
    val problem: String?,
)

object HostWriteCards {
    /** The backend takes a chat-scoped device's approval of these cards. */
    const val PHONE_APPROVAL_CAPABILITY = "agent_host_write_phone_approval_v1"

    private val VERDICT_ORDER = listOf("comment", "request_changes", "approve")
    private val VERDICT_LABEL = mapOf("comment" to "Comment", "request_changes" to "Request changes", "approve" to "Approve")
    private val HOST_LABEL = mapOf("github" to "GitHub", "bitbucket" to "Bitbucket")

    /** Null when the value is absent or not a card this app can answer. */
    fun decode(value: JsonValue?): HostWriteCard? {
        val raw = value as? JsonObject ?: return null
        val action = raw.string("action") ?: return null
        val review = (raw.values["review"] as? JsonObject)?.let { r ->
            HostWriteReview(
                summary = r.string("summary").orEmpty(),
                commentCount = (r.values["comments"] as? JsonArray)?.values?.size ?: 0,
                verdicts = (r.values["verdicts"] as? JsonArray)?.values.orEmpty().mapNotNull { (it as? JsonString)?.value },
            )
        }
        val range = raw.values["lineRange"] as? JsonObject
        return HostWriteCard(
            action = action,
            host = raw.string("host") ?: "github",
            prLabel = raw.string("prLabel").orEmpty(),
            location = raw.string("location"),
            suggestResolve = (raw.values["suggestResolve"] as? JsonBoolean)?.value == true,
            draft = ((raw.values["create"] as? JsonObject)?.values?.get("draft") as? JsonBoolean)?.value == true,
            lineRange = range?.let { r ->
                val start = r.long("start")
                val end = r.long("end")
                if (start != null && end != null) start to end else null
            },
            review = review,
            raw = raw,
        )
    }

    fun title(card: HostWriteCard): String = when (card.action) {
        "create" -> if (card.draft) "Open a draft pull request" else "Open a pull request"
        "reply" -> if (card.suggestResolve) "Reply and resolve a review conversation" else "Reply to a review conversation"
        "resolve" -> "Resolve a review conversation"
        "comment" -> card.lineRange?.let { "Comment on lines ${it.first}-${it.second}" } ?: "Comment on a line"
        "review" -> "Submit a review"
        else -> "Re-run a failed check"
    }

    /** "GitHub · app #612 · sync/worker.py:88". */
    fun context(card: HostWriteCard): String =
        listOfNotNull(HOST_LABEL[card.host] ?: card.host, card.prLabel.ifEmpty { null }, card.location).joinToString(" · ")

    fun buttons(card: HostWriteCard): List<HostWriteButton> {
        fun one(id: String, label: String) = listOf(HostWriteButton(id, label, true, HostWriteResponse(), null))
        return when (card.action) {
            "create" -> one("create", if (card.draft) "Open draft" else "Open pull request")
            "resolve" -> one("resolve", "Resolve")
            "rerun" -> one("rerun", "Re-run")
            "comment" -> one("comment", "Post comment")
            "review" -> {
                val review = card.review ?: return emptyList()
                VERDICT_ORDER.filter { it in review.verdicts }.map { verdict ->
                    HostWriteButton(verdict, VERDICT_LABEL.getValue(verdict), false, HostWriteResponse(verdict = verdict), verdictProblem(card.host, verdict, review))
                }
            }
            "reply" -> listOf(
                HostWriteButton("post", "Post reply", !card.suggestResolve, HostWriteResponse(resolve = false), null),
                HostWriteButton("post-resolve", "Post and resolve", card.suggestResolve, HostWriteResponse(resolve = true), null),
            )
            else -> emptyList()
        }
    }

    /** `reviewSubmitProblem` for a review sent as drafted; the size limits held when the agent drafted it. */
    private fun verdictProblem(host: String, verdict: String, review: HostWriteReview): String? {
        val summary = review.summary.trim()
        return when {
            verdict == "comment" && summary.isEmpty() && review.commentCount == 0 -> "Write a summary or add a comment on a line first."
            verdict == "request_changes" && summary.isEmpty() -> if (host == "github") "GitHub needs a summary to request changes." else "Say what should change."
            else -> null
        }
    }

    private fun JsonObject.string(key: String): String? = (values[key] as? JsonString)?.value
    private fun JsonObject.long(key: String): Long? =
        (values[key] as? JsonNumber)?.source?.toLongOrNull()
}
