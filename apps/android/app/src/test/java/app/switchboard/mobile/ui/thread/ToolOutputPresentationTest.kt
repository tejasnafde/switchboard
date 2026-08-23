package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolOutputPresentationTest {
    @Test
    fun fullOutputIsSplitIntoBoundedLazyPagesWithoutLosingContent() {
        val output = "start\n" + "x".repeat(20_000) + "\nunique end"
        val pages = ToolOutputPresenter.pages(output)

        assertTrue(pages.pageCount > 1)
        assertTrue((0 until pages.pageCount).all { pages.page(it).length <= ToolOutputPresenter.PageMaxChars })
        assertEquals(output, (0 until pages.pageCount).joinToString("") { pages.page(it) })
    }

    @Test
    fun pageBoundariesPreferExistingLineBreaks() {
        val output = "a".repeat(3_900) + "\n" + "b".repeat(3_900)
        val pages = ToolOutputPresenter.pages(output)

        assertTrue(pages.page(0).endsWith("\n"))
        assertEquals(output, (0 until pages.pageCount).joinToString("") { pages.page(it) })
    }

    @Test
    fun pageBoundariesDoNotSplitSurrogatePairs() {
        val output = "a".repeat(ToolOutputPresenter.PageMaxChars - 1) + "😀tail"
        val pages = ToolOutputPresenter.pages(output)

        assertFalse(pages.page(0).last().isHighSurrogate())
        assertEquals(output, (0 until pages.pageCount).joinToString("") { pages.page(it) })
    }
}
