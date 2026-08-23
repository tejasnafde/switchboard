package app.switchboard.mobile.ui.thread

data class ToolOutputPreview(
    val text: String,
    val truncated: Boolean,
)

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
    const val PreviewMaxChars = 12_000
    const val PageMaxChars = 4_000
    private const val TruncationMarker = "\n… output preview truncated"

    fun preview(output: String): ToolOutputPreview {
        if (output.length <= PreviewMaxChars) {
            return ToolOutputPreview(output, truncated = false)
        }
        return ToolOutputPreview(
            text = output.take(PreviewMaxChars - TruncationMarker.length) + TruncationMarker,
            truncated = true,
        )
    }

    fun pages(output: String): ToolOutputPages {
        val ranges = buildList {
            var start = 0
            while (start < output.length) {
                var end = (start + PageMaxChars).coerceAtMost(output.length)
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
