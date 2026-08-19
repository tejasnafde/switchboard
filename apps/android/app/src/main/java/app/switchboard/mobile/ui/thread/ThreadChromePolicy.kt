package app.switchboard.mobile.ui.thread

import java.util.Locale

object ThreadChromePolicy {
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
            metadata.model?.trim()?.takeIf(String::isNotEmpty),
            status,
        ).joinToString(" · ")
    }

    fun metadataSummary(metadata: ThreadMetadataPresentation): List<String> = listOfNotNull(
        metadata.contextLabel?.formatTokenCounts(),
        metadata.costLabel,
        metadata.durationLabel,
    )

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
        else -> replaceFirstChar(Char::uppercaseChar)
    }

    private fun String.formatTokenCounts(): String {
        val match = Regex("^(\\d+) / (\\d+) tokens$").matchEntire(this) ?: return this
        val used = match.groupValues[1].toLongOrNull() ?: return this
        val maximum = match.groupValues[2].toLongOrNull() ?: return this
        return String.format(Locale.US, "%,d / %,d tokens", used, maximum)
    }
}
