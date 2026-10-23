package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.remote.AcpAgents
import java.util.Locale

object ThreadChromePolicy {
    /** A turn this long shows "Worked for"; a shorter one shows it on long press. */
    const val TURN_DURATION_VISIBLE_MS = 30_000L

    fun showsTurnDuration(durationMs: Long?): Boolean =
        durationMs != null && durationMs >= TURN_DURATION_VISIBLE_MS

    /** Instance or provider, then status. The model is on the composer chip. */
    fun subtitle(metadata: ThreadMetadataPresentation): String {
        val status = when (metadata.status.lowercase(Locale.ROOT)) {
            "running", "working" -> "Working"
            "connecting", "retrying" -> "Reconnecting"
            "cached" -> "Saved locally"
            "error", "failed" -> "Needs attention"
            "idle", "ready" -> "Ready"
            else -> metadata.status.trim().takeIf(String::isNotEmpty)
        }
        if (status == "Saved locally") return status
        return listOfNotNull(
            metadata.instanceName?.trim()?.takeIf(String::isNotEmpty)
                ?: metadata.provider?.trim()?.takeIf(String::isNotEmpty)?.providerLabel(),
            status,
        ).joinToString(" · ")
    }

    fun metadataSummary(metadata: ThreadMetadataPresentation): List<String> = listOfNotNull(
        metadata.contextLabel?.formatTokenCounts(),
        metadata.costLabel,
        metadata.durationLabel?.let { "last turn $it" },
    )

    /** "576,511 of 1,000,000 tokens · $904.67 · last turn 1.3s", shown on a title tap. */
    fun usageLine(metadata: ThreadMetadataPresentation): String? =
        metadataSummary(metadata).takeIf { it.isNotEmpty() }?.joinToString(" · ")

    fun pendingApproval(rows: List<ThreadRowPresentation>): ThreadRowPresentation.Approval? =
        rows.asReversed()
            .filterIsInstance<ThreadRowPresentation.Approval>()
            .firstOrNull { it.source.state == "pending" }

    fun feedRows(rows: List<ThreadRowPresentation>): List<ThreadRowPresentation> {
        val slotKey = pendingApproval(rows)?.key ?: return rows
        return rows.filterNot { it.key == slotKey }
    }

    private fun String.providerLabel(): String = when (lowercase(Locale.ROOT)) {
        "codex" -> "Codex"
        "claude" -> "Claude"
        "opencode" -> "OpenCode"
        else -> AcpAgents.shortLabel(this) ?: replaceFirstChar(Char::uppercaseChar)
    }

    private fun String.formatTokenCounts(): String {
        val match = Regex("^(\\d+) / (\\d+) tokens$").matchEntire(this) ?: return this
        val used = match.groupValues[1].toLongOrNull() ?: return this
        val maximum = match.groupValues[2].toLongOrNull() ?: return this
        return String.format(Locale.US, "%,d of %,d tokens", used, maximum)
    }
}

object ThreadArchivePolicy {
    fun canArchive(status: String?, archiving: Boolean): Boolean =
        !archiving && status?.lowercase(Locale.ROOT) in setOf(
            "idle",
            "ready",
            "cached",
            "error",
            "failed",
        )
}
