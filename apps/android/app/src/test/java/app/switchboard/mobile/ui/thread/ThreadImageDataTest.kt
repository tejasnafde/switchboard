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

    @Test
    fun `accepts only absolute local file urls for staged images`() {
        assertEquals(
            "/data/user/0/app.switchboard.mobile/files/thread images/shot.png",
            ThreadImageFile.parse(
                "file:///data/user/0/app.switchboard.mobile/files/thread%20images/shot.png",
            )?.path,
        )
        assertNull(ThreadImageFile.parse("https://example.com/shot.png"))
        assertNull(ThreadImageFile.parse("file://remote-host/shot.png"))
        assertNull(ThreadImageFile.parse("file:relative.png"))
        assertNull(ThreadImageFile.parse("file:///tmp/shot.png?changed=1"))
    }
}
