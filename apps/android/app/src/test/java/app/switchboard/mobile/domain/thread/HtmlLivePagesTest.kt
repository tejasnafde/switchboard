package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HtmlLivePagesTest {
    @Test
    fun imageKeyIsTheHexSha256OfTheUtf8Source() {
        assertEquals(
            "9235215ba9292f8dd21fecf0305a4b7d067e4cb41901b6840e8a6f5f2551a065",
            HtmlLivePages.imageKey("<script src=\"/_sb/chart.js\"></script>\n<canvas id=\"c\"></canvas>"),
        )
        assertEquals(
            "039cda1cb184022e2fbb117ce36a746e5abafe0846b588428ef5b69d87410e9a",
            HtmlLivePages.imageKey("é<b>"),
        )
    }

    @Test
    fun infoTitleIsTrimmedCappedAndNullWhenEmpty() {
        assertEquals("Chart", HtmlLivePages.parseInfo("html-live title=\" Chart \"")?.title)
        assertEquals(120, HtmlLivePages.parseInfo("html-live title='${"x".repeat(200)}'")?.title?.length)
        assertNull(HtmlLivePages.parseInfo("HTML-LIVE")?.title)
        assertNull(HtmlLivePages.parseInfo("html title=\"x\""))
    }

    @Test
    fun anHtmlLiveBlockIsNotCappedBySourceSize() {
        val big = "<p>" + "x".repeat(ChatVisuals.MAX_VISUAL_SOURCE_CHARS + 10) + "</p>"
        val segments = ChatVisuals.splitVisualBlocks("```html-live\n$big\n```")
        assertEquals(listOf(MessageSegment.HtmlLive(big, null, true)), segments)
    }

    @Test
    fun aNullImageMeansNoImage() {
        assertEquals(HtmlLiveState(null, null), HtmlLivePages.decodeState(JsonCodec.parse("""{"image":null,"savedPath":null}""")))
        assertEquals(HtmlLiveState(null, null), HtmlLivePages.decodeState(JsonNull))
        assertNull(HtmlLivePages.decodeState(JsonCodec.parse("""{"image":"https://x/y.png","savedPath":null}""")).image)
        val state = HtmlLivePages.decodeState(JsonCodec.parse("""{"image":"data:image/png;base64,iVBORw0=","savedPath":"a.html"}"""))
        assertEquals(HtmlLiveState("data:image/png;base64,iVBORw0=", "a.html"), state)
    }

    @Test
    fun openAnswerIsTrueOnlyForOk() {
        assertTrue(HtmlLivePages.decodeOpened(JsonCodec.parse("""{"ok":true}""")))
        assertFalse(HtmlLivePages.decodeOpened(JsonCodec.parse("""{"ok":false}""")))
        assertFalse(HtmlLivePages.decodeOpened(null))
    }

    @Test
    fun openRequestCarriesTheThreadSourceAndTitle() {
        val request = HtmlLivePages.openRequest("t1", "<b>x</b>", null)
        assertEquals(JsonString("t1"), request.values["conversationId"])
        assertEquals(JsonString("<b>x</b>"), request.values["source"])
        assertEquals(JsonNull, request.values["title"])
    }
}
