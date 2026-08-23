package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolActivityLayoutPolicyTest {
    @Test
    fun collapsedRowsKeepTheAccessibleTargetWithoutLegacyCardPadding() {
        assertEquals(48, ToolActivityLayoutPolicy.CollapsedRowHeightDp)
        assertEquals(480, ToolActivityLayoutPolicy.collapsedTurnHeightDp(toolCount = 10))
        assertTrue(
            ToolActivityLayoutPolicy.collapsedTurnHeightDp(toolCount = 10) <
                ToolActivityLayoutPolicy.LegacyCollapsedTurnHeightDp,
        )
    }
}
