package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonValue

/**
 * Merge-back: a forked chat sends what it did since the fork point back to
 * its parent chat, as context. Port of the wire types in
 * src/shared/merge-back.ts; `MergeBackRow` (the stored card) lives in
 * `SystemMarkers.kt` next to its parser.
 */
const val FORK_MERGE_BACK_CAPABILITY = "fork_merge_back_v1"

/** `provider:merge-back-preview` answer. */
sealed interface MergeBackPreview {
    data class Ready(
        val parentId: String,
        val parentTitle: String,
        val text: String,
        val turns: Long,
        val omittedTurns: Long,
        val files: List<String>,
        val moreFiles: Long,
        /** A summary from this fork is already waiting in the parent; sending replaces it. */
        val replacesPending: Boolean,
        /** What the preview covered. Opaque: echoed back unchanged on send. */
        val token: JsonValue,
    ) : MergeBackPreview

    data class Empty(val parentTitle: String, val message: String) : MergeBackPreview

    data class Refused(val message: String) : MergeBackPreview
}

/** `provider:merge-back-send` / `-edit` / `-discard` answer. */
sealed interface MergeBackActionResult {
    data object Ok : MergeBackActionResult
    data class Refused(val message: String) : MergeBackActionResult
}

/** The line above the editable summary: "2 turns · 3 files changed". Port of `mergeBackPreviewNote`. */
fun mergeBackPreviewNote(preview: MergeBackPreview.Ready): String {
    val files = preview.files.size + preview.moreFiles
    val turnsPart = plural(preview.turns, "turn") +
        if (preview.omittedTurns > 0) " (${preview.omittedTurns} oldest left out to fit)" else ""
    return "$turnsPart · ${plural(files, "file")} changed"
}

private fun plural(count: Long, word: String): String = "$count $word${if (count == 1L) "" else "s"}"
