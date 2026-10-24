package app.switchboard.mobile.domain.reviews

import java.security.SecureRandom
import java.util.Locale

/**
 * Pull request writes from this phone: reply, resolve, a comment on the whole
 * pull request, and a review with no line comments. Ported from
 * src/shared/pull-request-phone-writes.ts and src/shared/pull-request-writes.ts.
 * The digest vectors are pinned in PhonePrWritesTest, and the copy is checked
 * against tests/fixtures/phone-pr-write-copy.json.
 */
object PhonePrWrites {
    /** The backend takes phone writes with a proof and grants `pr-write` from the desktop. */
    const val CAPABILITY = "pr_write_scope_v1"

    /** The device scope the desktop grants. Without it the phone only reads. */
    const val SCOPE = "pr-write"

    /** `PR_TEXT_MAX_CHARS`: one cap for a reply, comment or review summary on both hosts. */
    const val TEXT_MAX_CHARS = 60_000

    /** A write rejected with this prefix means the desktop removed the scope. */
    const val NOT_PERMITTED_PREFIX = "not permitted"

    private const val DIGEST_VERSION = "sb-pr-write-1"
    private const val WRITE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val WRITE_ID = Regex("^[A-Za-z0-9_-]{16,64}$")
    private const val FNV_OFFSET = 0xcbf29ce484222325uL
    private const val FNV_PRIME = 0x100000001b3uL

    /** `fnv1a64Hex`: FNV-1a 64 over the UTF-16 code units, low byte first, as 16 hex digits. */
    fun fnv1a64Hex(input: String): String {
        var hash = FNV_OFFSET
        for (char in input) {
            val unit = char.code
            hash = (hash xor (unit and 0xff).toULong()) * FNV_PRIME
            hash = (hash xor (unit ushr 8).toULong()) * FNV_PRIME
        }
        return hash.toString(16).padStart(16, '0')
    }

    /** `phonePrWriteDigest`: the fields in the TypeScript order, joined by NUL. */
    fun digest(sheet: PhonePrWriteSheet): String = fnv1a64Hex(
        listOf(
            DIGEST_VERSION,
            sheet.writeId,
            sheet.ref.host,
            sheet.ref.owner,
            sheet.ref.name,
            sheet.ref.number.toString(),
            sheet.action.wire,
            sheet.conversationId.orEmpty(),
            sheet.event?.wire.orEmpty(),
            sheet.account,
            sheet.text,
        ).joinToString("\u0000"),
    )

    fun isWriteId(value: String): Boolean = WRITE_ID.matches(value)

    /** A new write id for one Post tap: 'w_' and 24 random base64url characters. */
    fun mintWriteId(random: SecureRandom = SecureRandom()): String =
        "w_" + String(CharArray(24) { WRITE_ID_ALPHABET[random.nextInt(WRITE_ID_ALPHABET.length)] })

    /** `prTextLimitNote`: the host-named note under a composer once the text passes the cap. */
    fun prTextLimitNote(host: String, length: Int): String? {
        if (length <= TEXT_MAX_CHARS) return null
        val max = String.format(Locale.US, "%,d", TEXT_MAX_CHARS)
        val over = String.format(Locale.US, "%,d", length - TEXT_MAX_CHARS)
        return if (host == "github") {
            "GitHub takes at most 65,536 characters. Switchboard stops at $max. Remove $over."
        } else {
            "Bitbucket sets its own limit. Switchboard stops at $max. Remove $over."
        }
    }

    /** `reviewEventsFor`: the author may only comment on their own pull request. */
    fun reviewEventsFor(viewer: PrViewer): List<ReviewEvent> =
        if (viewer.isAuthor) listOf(ReviewEvent.Comment) else ReviewEvent.entries.toList()

    /** The verdicts this phone offers: approve and request changes only while the pull request is open. */
    fun phoneReviewEvents(pr: PrSummary): List<ReviewEvent> =
        reviewEventsFor(pr.viewer).filter { it == ReviewEvent.Comment || pr.state == "open" }

    /** `reviewSubmitProblem` with no line comments: why the review cannot go, or null. */
    fun reviewSubmitProblem(host: String, event: ReviewEvent, body: String): String? {
        val text = body.trim()
        if (text.length > TEXT_MAX_CHARS) return "The summary is too long."
        if (event == ReviewEvent.Comment && text.isEmpty()) return "Write a summary or add a comment on a line first."
        if (event == ReviewEvent.RequestChanges && text.isEmpty()) {
            return if (host == "github") "GitHub needs a summary to request changes." else "Say what should change."
        }
        return null
    }

    /** `PHONE_PR_WRITE_COPY`. */
    object Copy {
        const val NO_SCOPE_TITLE = "This phone can read threads, not post to them."
        const val NO_SCOPE_BODY =
            "To allow writes, open Settings on your computer, then Devices & machines, this phone, Details, and choose Allow."
        const val NO_PASSCODE = "Set a passcode on this phone to post from it."
        const val NOT_SURE_TITLE = "Not sure it posted"
        const val NOT_SURE_BODY =
            "The connection dropped before the computer answered. Switchboard does not send it again. Check the thread first."
        const val REMOVED = "The desktop removed pull request writes for this phone. Your text is kept."
        const val APPROVE_NOTE = "Approving does not merge."

        /** Keyed like the TypeScript object, for the fixture check. */
        val all: Map<String, String> = linkedMapOf(
            "noScopeTitle" to NO_SCOPE_TITLE,
            "noScopeBody" to NO_SCOPE_BODY,
            "noPasscode" to NO_PASSCODE,
            "notSureTitle" to NOT_SURE_TITLE,
            "notSureBody" to NOT_SURE_BODY,
            "removed" to REMOVED,
            "approveNote" to APPROVE_NOTE,
        )
    }
}

enum class PhonePrWriteAction(val wire: String, val channel: String) {
    Reply("reply", "pull-requests:reply"),
    Resolve("resolve", "pull-requests:resolve"),
    Comment("comment", "pull-requests:comment"),
    Review("review", "pull-requests:submit-review"),
}

enum class ReviewEvent(val wire: String, val label: String) {
    Comment("comment", "Comment"),
    Approve("approve", "Approve"),
    RequestChanges("request_changes", "Request changes"),
}

/** Everything the confirm sheet shows, and so everything the digest binds. */
data class PhonePrWriteSheet(
    val account: String,
    val ref: PrRef,
    val action: PhonePrWriteAction,
    /** The thread of a reply or resolve; null for a comment or review. */
    val conversationId: String?,
    /** The verdict of a review; null otherwise. */
    val event: ReviewEvent?,
    /** The exact body sent; empty for resolve. */
    val text: String,
    val writeId: String,
)

data class PrComment(
    val id: String,
    val author: PrPerson,
    val body: String,
    val createdAt: Long,
)

/** `PrConversation`: a review thread, or a comment on the whole pull request when [path] is null. */
data class PrConversation(
    val id: String,
    val path: String?,
    val line: Long?,
    val startLine: Long?,
    val resolved: Boolean,
    val outdated: Boolean,
    val comments: List<PrComment>,
) {
    /** `path:line`, the path alone, or "General". */
    val location: String
        get() = when {
            path == null -> "General"
            line == null -> path
            startLine != null && startLine != line -> "$path:$startLine-$line"
            else -> "$path:$line"
        }
}
