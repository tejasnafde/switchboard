package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadImageDataTest {
    @Test
    fun `accepts bounded raster data urls without decoding on the main thread`() {
        val image = ThreadImageData.parse("data:image/png;base64,iVBORw0KGgo=")

        assertEquals("image/png", image?.mimeType)
        assertEquals("iVBORw0KGgo=", image?.base64)
        assertEquals(8, image?.decodedBytes)
    }

    @Test
    fun `rejects active non-raster data and malformed base64`() {
        assertNull(ThreadImageData.parse("data:image/svg+xml;base64,PHN2Zz4="))
        assertNull(ThreadImageData.parse("data:text/html;base64,PGgxPk5vPC9oMT4="))
        assertNull(ThreadImageData.parse("data:image/png;base64,%%%"))
        assertNull(ThreadImageData.parse("https://example.com/image.png"))
    }

    @Test
    fun `rejects payload before allocation when decoded size exceeds the wire ceiling`() {
        assertTrue(ThreadImageData.MaxDecodedBytes > 2)
        assertNull(ThreadImageData.parse("data:image/jpeg;base64,AAAA", maxDecodedBytes = 2))
    }
}
