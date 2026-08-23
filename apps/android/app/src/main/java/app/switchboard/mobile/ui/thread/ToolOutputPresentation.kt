package app.switchboard.mobile.ui.thread

class ToolOutputPages internal constructor(
    private val output: String,
    private val ranges: List<IntRange>,
) {
    val pageCount: Int
        get() = ranges.size

    fun page(index: Int): String {
        val range = ranges[index]
        return output.substring(range.first, range.last + 1)
    }
}

object ToolOutputPresenter {
    const val PageMaxChars = 4_000

    fun pages(output: String): ToolOutputPages {
        val ranges = buildList {
            var start = 0
            while (start < output.length) {
                var end = (start + PageMaxChars).coerceAtMost(output.length)
                if (end < output.length) {
                    val lineEnd = output.lastIndexOf('\n', end - 1)
                    if (lineEnd >= start + PageMaxChars / 2) end = lineEnd + 1
                }
                if (
                    end < output.length &&
                    Character.isHighSurrogate(output[end - 1]) &&
                    Character.isLowSurrogate(output[end])
                ) {
                    end -= 1
                }
                add(start until end)
                start = end
            }
        }
        return ToolOutputPages(output, ranges)
    }
}
