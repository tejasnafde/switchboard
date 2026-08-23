package app.switchboard.mobile.ui.thread

data class ToolOutputPreview(
    val text: String,
    val fullText: String,
    val truncated: Boolean,
)

object ToolOutputPresenter {
    const val PreviewMaxChars = 12_000
    private const val TruncationMarker = "\n… output preview truncated"

    fun preview(output: String): ToolOutputPreview {
        if (output.length <= PreviewMaxChars) {
            return ToolOutputPreview(output, output, truncated = false)
        }
        return ToolOutputPreview(
            text = output.take(PreviewMaxChars - TruncationMarker.length) + TruncationMarker,
            fullText = output,
            truncated = true,
        )
    }
}
