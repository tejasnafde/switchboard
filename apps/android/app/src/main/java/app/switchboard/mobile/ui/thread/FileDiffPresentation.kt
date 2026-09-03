package app.switchboard.mobile.ui.thread

enum class DiffLineKind {
    Context,
    Added,
    Removed,
    Omitted,
}

data class CompactDiffLine(
    val kind: DiffLineKind,
    val text: String,
    val oldLine: Int? = null,
    val newLine: Int? = null,
)

data class CompactFileDiff(
    val lines: List<CompactDiffLine>,
    val addedLines: Int,
    val removedLines: Int,
    val truncated: Boolean,
    val countsExact: Boolean,
)

object FileDiffPresenter {
    const val MAX_VISIBLE_ROWS = 160
    private const val CONTEXT_LINES = 2
    private const val MAX_ALIGNMENT_CELLS = 90_000

    // Per-side bound: the cell product is zero when one side is empty.
    private const val MAX_ALIGNMENT_LINES = 3_000
    private const val MAX_LINE_CHARS = 320

    fun present(oldContent: String, newContent: String): CompactFileDiff {
        val oldLines = oldContent.toDiffLines()
        val newLines = newContent.toDiffLines()
        return if (alignable(oldLines.size, newLines.size)) {
            exact(oldLines, newLines)
        } else {
            boundedFallback(oldLines, newLines)
        }
    }

    internal fun alignable(oldSize: Int, newSize: Int): Boolean =
        oldSize <= MAX_ALIGNMENT_LINES &&
            newSize <= MAX_ALIGNMENT_LINES &&
            oldSize.toLong() * newSize.toLong() <= MAX_ALIGNMENT_CELLS

    private fun exact(oldLines: List<String>, newLines: List<String>): CompactFileDiff {
        val table = Array(oldLines.size + 1) { IntArray(newLines.size + 1) }
        for (oldIndex in oldLines.indices.reversed()) {
            for (newIndex in newLines.indices.reversed()) {
                table[oldIndex][newIndex] = if (oldLines[oldIndex] == newLines[newIndex]) {
                    table[oldIndex + 1][newIndex + 1] + 1
                } else {
                    maxOf(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1])
                }
            }
        }

        val rows = mutableListOf<CompactDiffLine>()
        var oldIndex = 0
        var newIndex = 0
        while (oldIndex < oldLines.size || newIndex < newLines.size) {
            when {
                oldIndex < oldLines.size &&
                    newIndex < newLines.size &&
                    oldLines[oldIndex] == newLines[newIndex] -> {
                    rows += CompactDiffLine(
                        DiffLineKind.Context,
                        oldLines[oldIndex].bounded(),
                        oldLine = oldIndex + 1,
                        newLine = newIndex + 1,
                    )
                    oldIndex += 1
                    newIndex += 1
                }

                oldIndex < oldLines.size &&
                    (newIndex == newLines.size || table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) -> {
                    rows += CompactDiffLine(
                        DiffLineKind.Removed,
                        oldLines[oldIndex].bounded(),
                        oldLine = oldIndex + 1,
                    )
                    oldIndex += 1
                }

                else -> {
                    rows += CompactDiffLine(
                        DiffLineKind.Added,
                        newLines[newIndex].bounded(),
                        newLine = newIndex + 1,
                    )
                    newIndex += 1
                }
            }
        }

        val compact = compactContext(rows)
        val visible = compact.take(MAX_VISIBLE_ROWS)
        return CompactFileDiff(
            lines = visible,
            addedLines = rows.count { it.kind == DiffLineKind.Added },
            removedLines = rows.count { it.kind == DiffLineKind.Removed },
            truncated = compact.size > visible.size,
            countsExact = true,
        )
    }

    private fun boundedFallback(oldLines: List<String>, newLines: List<String>): CompactFileDiff {
        val prefix = oldLines.indices
            .takeWhile { it < newLines.size && oldLines[it] == newLines[it] }
            .count()
        var suffix = 0
        while (
            suffix < oldLines.size - prefix &&
            suffix < newLines.size - prefix &&
            oldLines[oldLines.lastIndex - suffix] == newLines[newLines.lastIndex - suffix]
        ) {
            suffix += 1
        }

        val oldChanged = oldLines.subList(prefix, oldLines.size - suffix)
        val newChanged = newLines.subList(prefix, newLines.size - suffix)
        val rows = mutableListOf<CompactDiffLine>()
        val leadingContextStart = maxOf(0, prefix - CONTEXT_LINES)
        for (index in leadingContextStart until prefix) {
            rows += CompactDiffLine(
                DiffLineKind.Context,
                oldLines[index].bounded(),
                oldLine = index + 1,
                newLine = index + 1,
            )
        }

        val mutationBudget = MAX_VISIBLE_ROWS - rows.size - minOf(CONTEXT_LINES, suffix)
        val removedBudget = minOf(oldChanged.size, mutationBudget / 2)
        val addedBudget = minOf(newChanged.size, mutationBudget - removedBudget)
        oldChanged.take(removedBudget).forEachIndexed { index, line ->
            rows += CompactDiffLine(DiffLineKind.Removed, line.bounded(), oldLine = prefix + index + 1)
        }
        newChanged.take(addedBudget).forEachIndexed { index, line ->
            rows += CompactDiffLine(DiffLineKind.Added, line.bounded(), newLine = prefix + index + 1)
        }

        val omittedMutations = oldChanged.size - removedBudget + newChanged.size - addedBudget
        if (omittedMutations > 0 && rows.size < MAX_VISIBLE_ROWS) {
            rows += CompactDiffLine(DiffLineKind.Omitted, "… $omittedMutations changed lines not shown")
        }
        val suffixBudget = minOf(CONTEXT_LINES, suffix, MAX_VISIBLE_ROWS - rows.size)
        repeat(suffixBudget) { offset ->
            val oldIndex = oldLines.size - suffix + offset
            val newIndex = newLines.size - suffix + offset
            rows += CompactDiffLine(
                DiffLineKind.Context,
                oldLines[oldIndex].bounded(),
                oldLine = oldIndex + 1,
                newLine = newIndex + 1,
            )
        }

        return CompactFileDiff(
            lines = rows,
            addedLines = newChanged.size,
            removedLines = oldChanged.size,
            truncated = omittedMutations > 0,
            countsExact = false,
        )
    }

    private fun compactContext(rows: List<CompactDiffLine>): List<CompactDiffLine> {
        val changed = rows.indices.filter { rows[it].kind != DiffLineKind.Context }
        if (changed.isEmpty()) return emptyList()
        val visible = BooleanArray(rows.size)
        changed.forEach { index ->
            for (candidate in maxOf(0, index - CONTEXT_LINES)..minOf(rows.lastIndex, index + CONTEXT_LINES)) {
                visible[candidate] = true
            }
        }
        val compact = mutableListOf<CompactDiffLine>()
        var index = 0
        while (index < rows.size) {
            if (visible[index]) {
                compact += rows[index]
                index += 1
            } else {
                val start = index
                while (index < rows.size && !visible[index]) index += 1
                compact += CompactDiffLine(DiffLineKind.Omitted, "… ${index - start} unchanged lines")
            }
        }
        return compact
    }

    private fun String.bounded(): String =
        if (length <= MAX_LINE_CHARS) this else take(MAX_LINE_CHARS - 1) + "…"

    private fun String.toDiffLines(): List<String> {
        if (isEmpty()) return emptyList()
        val normalized = replace("\r\n", "\n").replace('\r', '\n')
        return normalized.split('\n').let { lines ->
            if (lines.lastOrNull().isNullOrEmpty()) lines.dropLast(1) else lines
        }
    }
}
