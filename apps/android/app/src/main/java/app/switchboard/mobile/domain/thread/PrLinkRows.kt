package app.switchboard.mobile.domain.thread

/** One pull request, as the backend identifies it on `pull-requests:links`. */
data class PrLinkRef(
    val host: String,
    val owner: String,
    val name: String,
    val number: Long,
)

/**
 * A pull request linked to a chat, and how the link was made. Ported from
 * `PrLink` in src/shared/pull-request-links.ts; the backend reads it under
 * the chat's root conversation, so a provider session rotation keeps it.
 */
data class PrLink(
    val ref: PrLinkRef,
    /** `manual` | `auto` | `agent` | `created`; any other string reads as unknown. */
    val source: String,
    val linkedAt: Long,
    /** The PR's state when the backend last read it; absent from older backends. */
    val state: String? = null,
    val stateAt: Long? = null,
)

/** `pull-requests:unlink` result: `{ ok: true }` or `{ ok: false, message }`. */
sealed interface PrLinkUnlinkResult {
    data object Ok : PrLinkUnlinkResult
    data class Refused(val message: String) : PrLinkUnlinkResult
}

/**
 * One line for a phone's link list: "#612 · merged · Opened by the agent ·
 * owner/name", the repository last so a one-line row cuts it off rather than
 * the state or source. Ported from `phoneLinkRowText` + `linkSourceLabel` in
 * src/shared/pull-request-links.ts; keep them in sync. Both suites run
 * tests/fixtures/pr-link-rows.json.
 */
object PrLinkRows {
    private val SOURCE_LABELS = mapOf(
        "manual" to "Linked by you",
        "auto" to "Linked automatically",
        "agent" to "Linked by the agent",
        "created" to "Opened by the agent",
    )

    fun text(link: PrLink): String {
        val parts = mutableListOf("#${link.ref.number}")
        if (link.state != null && link.state != "open") parts += link.state
        parts += (SOURCE_LABELS[link.source] ?: "Linked")
        parts += "${link.ref.owner}/${link.ref.name}"
        return parts.joinToString(" · ")
    }

    /** Accessible name of a link's Unlink button. Ported from `unlinkPrLabel`. */
    fun unlinkLabel(ref: PrLinkRef): String = "Unlink pull request ${ref.owner}/${ref.name} #${ref.number}"
}
