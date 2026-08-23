package app.switchboard.mobile.ui.thread

object ToolActivityLayoutPolicy {
    const val CollapsedRowHeightDp = 48
    const val LegacyCollapsedTurnHeightDp = 900

    fun collapsedTurnHeightDp(toolCount: Int): Int =
        toolCount.coerceAtLeast(0) * CollapsedRowHeightDp
}
