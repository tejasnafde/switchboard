package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.MessageSegment
import org.junit.Assert.assertEquals
import org.junit.Test

class HtmlLiveRenderingTest {
    @Test
    fun anUnclosedHtmlLiveFenceRendersAsCode() {
        assertEquals(
            listOf(
                listOf(RichTextBlock.Paragraph(listOf(RichInline.Text("Writing:")))),
                listOf(RichTextBlock.Code("html-live", "<div>\n<p>par")),
            ),
            renderedSegments("Writing:\n```html-live\n<div>\n<p>par"),
        )
    }

    @Test
    fun aClosedHtmlLiveFenceRendersAsTheCard() {
        assertEquals(
            listOf(MessageSegment.HtmlLive("<b>x</b>", "T", closed = true)),
            renderedSegments("```html-live title=\"T\"\n<b>x</b>\n```"),
        )
    }
}
