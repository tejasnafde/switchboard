package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
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
data class HostWriteResponse(
    val resolve: Boolean? = null,
    val verdict: String? = null,
    /** [HostWriteCards.shownDigest] of the draft this phone showed in full; the backend refuses an approval without it. */
    val shown: String? = null,
) {
    fun toJson(): JsonObject = JsonObject(
        linkedMapOf<String, JsonValue>().apply {
            resolve?.let { put("resolve", JsonBoolean(it)) }
            verdict?.let { put("verdict", JsonString(it)) }
            shown?.let { put("shown", JsonString(it)) }
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

/** One labelled block of a phone card: a title, a reply, one review comment. */
data class HostWritePreviewSection(val label: String, val text: String)

data class HostWritePreview(
    /** Everything the approval posts, in full, plus the reviewer comment a reply answers. */
    val sections: List<HostWritePreviewSection>,
    /** Too long to show at once: the card starts collapsed and approval waits until it is opened. */
    val long: Boolean,
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

    /**
     * The card's whole content for the phone to show before it approves, or
     * null when the payload lacks something the approval would post, so the
     * user approves on the desktop instead. Never `detail`: that caps long
     * comments. Ports `hostWritePreview` in `src/shared/host-write-phone.ts`.
     */
    fun preview(card: HostWriteCard): HostWritePreview? {
        val raw = card.raw
        val sections = mutableListOf<HostWritePreviewSection>()
        fun add(label: String, text: String) {
            if (text.isNotEmpty()) sections += HostWritePreviewSection(label, text)
        }
        (raw.values["quote"] as? JsonObject)?.let { quote ->
            val author = quote.string("author")
            val body = quote.string("body")
            if (author != null && body != null) add("$author wrote", body)
        }
        when (card.action) {
            "create" -> {
                val create = raw.values["create"] as? JsonObject ?: return null
                val title = create.string("title")?.takeIf { it.isNotEmpty() } ?: return null
                val description = create.values["description"]
                if (description != null && description !is JsonString) return null
                add("Branches", "${create.string("repoLabel").orEmpty()}: ${create.string("sourceBranch").orEmpty()} -> ${create.string("targetBranch").orEmpty()}")
                add("Title", title)
                add("Description", (description as? JsonString)?.value.orEmpty())
                if (create.values.containsKey("reviewers")) {
                    val reviewers = create.values["reviewers"] as? JsonArray ?: return null
                    val labels = reviewers.values.map { value ->
                        val reviewer = value as? JsonObject ?: return null
                        reviewerLabel(reviewer.string("login") ?: return null, reviewer.string("displayName") ?: return null)
                    }
                    // One line each, so the approval (which requests all of them) shows every one.
                    add("Reviewers", labels.joinToString("\n"))
                }
            }
            "reply", "comment" -> {
                val text = raw.string("replyText")?.takeIf { it.isNotEmpty() } ?: return null
                add(if (card.action == "reply") "Reply" else "Comment", text)
            }
            "review" -> {
                val review = raw.values["review"] as? JsonObject ?: return null
                val comments = review.values["comments"] as? JsonArray ?: return null
                val summary = review.values["summary"]
                if (summary != null && summary !is JsonString) return null
                add("Summary", (summary as? JsonString)?.value.orEmpty())
                for (value in comments.values) {
                    val comment = value as? JsonObject ?: return null
                    val path = comment.string("path") ?: return null
                    val line = comment.long("line") ?: return null
                    val text = comment.string("text") ?: return null
                    add(lineLocation(path, line, comment.long("startLine"), comment.string("side")), text)
                }
            }
            "rerun" -> add("Check", raw.string("checkName") ?: "a failed check")
            "resolve" -> Unit
            else -> return null
        }
        val lines = sections.sumOf { 1 + it.text.split('\n').size }
        val chars = sections.sumOf { it.label.length + it.text.length }
        return HostWritePreview(sections, lines > PREVIEW_COLLAPSED_LINES || chars > PREVIEW_COLLAPSED_CHARS)
    }

    /**
     * A fingerprint of one card as this phone showed it: FNV-1a 64 over the
     * UTF-16 code units (low byte first) of the request id, the target (host,
     * repository, PR number; for a create, the source and target branches),
     * the action and every [preview] section's label and text (a create's
     * reviewers included), joined by NUL.
     * Ports `hostWriteShownDigest` in `src/shared/host-write-phone.ts`, which
     * the backend recomputes; `HostWriteCardsTest` pins the same vectors as the
     * vitest suite. Null without a preview or a target.
     */
    fun shownDigest(requestId: String, card: HostWriteCard): String? {
        val preview = preview(card) ?: return null
        val raw = card.raw
        val host = raw.string("host") ?: return null
        val target = raw.values["target"] as? JsonObject ?: return null
        val repository = target.string("repository") ?: return null
        val number = when (val value = target.values["number"]) {
            is JsonNumber -> value.source.toLongOrNull()?.toString() ?: return null
            JsonNull -> ""
            else -> return null
        }
        val create = raw.values["create"] as? JsonObject
        val input = (
            listOf(
                SHOWN_DIGEST_VERSION, requestId, host, repository, number,
                create?.string("sourceBranch").orEmpty(), create?.string("targetBranch").orEmpty(), card.action,
            ) + preview.sections.flatMap { listOf(it.label, it.text) }
            ).joinToString("\u0000")
        var hash = FNV_OFFSET
        for (unit in input) {
            hash = (hash xor (unit.code and 0xff).toLong()) * FNV_PRIME
            hash = (hash xor (unit.code ushr 8).toLong()) * FNV_PRIME
        }
        return java.lang.Long.toUnsignedString(hash, 16).padStart(16, '0')
    }

    private const val SHOWN_DIGEST_VERSION = "sb-shown-2"
    private const val FNV_OFFSET = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
    private const val FNV_PRIME = 0x100000001b3L

    private const val PREVIEW_COLLAPSED_LINES = 12
    private const val PREVIEW_COLLAPSED_CHARS = 800

    /** "Jane Doe (jdoe)", or the login alone, as `reviewerLabel` in `src/shared/agent-pr-reviewers.ts`. */
    private fun reviewerLabel(login: String, displayName: String): String =
        if (displayName == login) login else "$displayName ($login)"

    /** "a.ts:4-9 (old)", as `lineLocation` in `src/shared/pull-request-writes.ts`. */
    private fun lineLocation(path: String, line: Long, startLine: Long?, side: String?): String {
        val lines = if (startLine != null && startLine < line) "$startLine-$line" else "$line"
        return "$path:$lines${if (side == "old") " (old)" else ""}"
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
