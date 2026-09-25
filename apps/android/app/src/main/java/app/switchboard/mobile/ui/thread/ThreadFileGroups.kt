package app.switchboard.mobile.ui.thread

/**
 * A turn's changed files fold behind one "Changed N files" row, collapsed by
 * default like the desktop's `chat.showFileDiffs` off, and expanded per turn.
 * A turn is everything between two user rows. The group sits where the
 * turn's first file row was; expanded, the file rows follow it.
 */
object ThreadFileGroups {
    fun label(count: Int): String = "Changed $count file${if (count == 1) "" else "s"}"

    fun collapse(rows: List<ThreadRowPresentation>, expanded: Set<String>): List<ThreadRowPresentation> {
        val result = mutableListOf<ThreadRowPresentation>()
        var turn = mutableListOf<ThreadRowPresentation>()
        fun flush() {
            val files = turn.filterIsInstance<ThreadRowPresentation.FileEdit>()
            turn.forEach { row ->
                when {
                    row !is ThreadRowPresentation.FileEdit -> result += row
                    row === files.first() -> {
                        val key = "files:${row.key}"
                        val open = key in expanded
                        result += ThreadRowPresentation.FileGroup(
                            key = key,
                            label = label(files.size),
                            addedLines = files.sumOf { it.addedLines },
                            removedLines = files.sumOf { it.removedLines },
                            expanded = open,
                        )
                        if (open) result += files
                    }
                }
            }
            turn = mutableListOf()
        }
        rows.forEach { row ->
            if (row is ThreadRowPresentation.User) flush()
            turn += row
        }
        flush()
        return result
    }
}
