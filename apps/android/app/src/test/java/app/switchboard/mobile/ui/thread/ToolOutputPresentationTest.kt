package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolOutputPresentationTest {
    @Test
    fun shortOutputRemainsComplete() {
        val preview = ToolOutputPresenter.preview("all output")

        assertEquals("all output", preview.text)
        assertFalse(preview.truncated)
    }

    @Test
    fun largeOutputHasABoundedPreviewAndAnExplicitFullValuePath() {
        val output = "start\n" + "x".repeat(20_000) + "\nunique end"
        val preview = ToolOutputPresenter.preview(output)

        assertTrue(preview.truncated)
        assertTrue(preview.text.length <= ToolOutputPresenter.PreviewMaxChars)
        assertTrue(preview.text.startsWith("start"))
        assertFalse(preview.text.contains("unique end"))
    }

    @Test
    fun fullOutputIsSplitIntoBoundedLazyPagesWithoutLosingContent() {
        val output = "start\n" + "x".repeat(20_000) + "\nunique end"
        val pages = ToolOutputPresenter.pages(output)

        assertTrue(pages.pageCount > 1)
        assertTrue((0 until pages.pageCount).all { pages.page(it).length <= ToolOutputPresenter.PageMaxChars })
        assertEquals(output, (0 until pages.pageCount).joinToString("") { pages.page(it) })
    }
}
