package app.switchboard.mobile.ui.components

import androidx.compose.ui.unit.dp
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.SwitchboardDimensions
import org.junit.Assert.assertEquals
import org.junit.Test

class UiFoundationContractTest {
    @Test
    fun `all standalone controls keep the 48 dp touch target`() {
        assertEquals(48.dp, SwitchboardDimensions.minimumTouchTarget)
    }

    @Test
    fun `status tones use the canonical restrained palette`() {
        assertEquals(TextDim, StatusTone.NEUTRAL.indicatorColor)
        assertEquals(Accent, StatusTone.INFO.indicatorColor)
        assertEquals(Green, StatusTone.SUCCESS.indicatorColor)
        assertEquals(Amber, StatusTone.WARNING.indicatorColor)
        assertEquals(Red, StatusTone.ERROR.indicatorColor)
    }

    @Test
    fun `inline status chooses the matching material indicator`() {
        assertEquals(StatusIndicatorKind.NONE, InlineStatusProgress.None.indicatorKind)
        assertEquals(StatusIndicatorKind.INDETERMINATE, InlineStatusProgress.Indeterminate.indicatorKind)
        assertEquals(StatusIndicatorKind.DETERMINATE, InlineStatusProgress.Determinate(0.4f).indicatorKind)
    }

    @Test
    fun `determinate status progress is bounded for material progress indicators`() {
        assertEquals(0f, InlineStatusProgress.Determinate(-1f).boundedValue)
        assertEquals(0.4f, InlineStatusProgress.Determinate(0.4f).boundedValue)
        assertEquals(1f, InlineStatusProgress.Determinate(3f).boundedValue)
    }
}
