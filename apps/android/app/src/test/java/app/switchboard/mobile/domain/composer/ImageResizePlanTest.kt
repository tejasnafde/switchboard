package app.switchboard.mobile.domain.composer

import app.switchboard.mobile.domain.composer.ImageResizePlan.Format
import app.switchboard.mobile.domain.composer.ImageResizePlan.Outcome
import app.switchboard.mobile.domain.composer.ImageResizePlan.Refusal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageResizePlanTest {
    @Test
    fun `fits the long side without upscaling`() {
        assertEquals(ImageResizePlan.Size(2048, 1536), ImageResizePlan.fitWithin(4032, 3024, 2048))
        assertEquals(ImageResizePlan.Size(1536, 2048), ImageResizePlan.fitWithin(3024, 4032, 2048))
        assertEquals(ImageResizePlan.Size(800, 600), ImageResizePlan.fitWithin(800, 600, 2048))
    }

    @Test
    fun `a 50 MP photo decodes at no more than twice the target`() {
        assertEquals(2, ImageResizePlan.sampleSize(8160, 6120, 2048))
        assertEquals(4, ImageResizePlan.sampleSize(8192, 6144, 2048))
        assertEquals(1, ImageResizePlan.sampleSize(3000, 2000, 2048))
        assertEquals(1, ImageResizePlan.sampleSize(1000, 800, 2048))
    }

    @Test
    fun `steps match the shared rules`() {
        assertEquals(listOf(2048 to 85, 1600 to 85, 1280 to 75), ImageResizePlan.JPEG_STEPS.map { it.maxSide to it.quality })
        assertEquals(Format.PNG, ImageResizePlan.attempts("image/png")!!.first().format)
        assertEquals(ImageResizePlan.JPEG_STEPS, ImageResizePlan.attempts("image/webp"))
        assertNull(ImageResizePlan.attempts("image/gif"))
    }

    @Test
    fun `wire bytes match the encoded data URL`() {
        assertEquals("data:image/jpeg;base64,aGVsbG8=".length.toLong(), ImageResizePlan.dataUrlWireBytes("image/jpeg", 5))
    }

    @Test
    fun `steps down until it fits, and keeps only a small PNG as PNG`() {
        val sizes = mapOf("PNG@2048" to 2_000_000L, "JPEG@2048" to 4_000_000L, "JPEG@1600" to 2_500_000L)
        val tried = mutableListOf<String>()
        val outcome = ImageResizePlan.shrink(ImageResizePlan.attempts("image/png")!!, ImageResizePlan.MESSAGE_WIRE_BUDGET) {
            val key = "${it.format}@${it.maxSide}"
            tried += key
            key to sizes.getValue(key)
        }
        assertEquals(Outcome.Fitted("JPEG@1600", ImageResizePlan.JPEG_STEPS[1]), outcome)
        assertEquals(listOf("PNG@2048", "JPEG@2048", "JPEG@1600"), tried)
    }

    @Test
    fun `tells a full message from an image too large alone`() {
        val small = ImageResizePlan.shrink(ImageResizePlan.JPEG_STEPS, 100) { "x" to 1_000L }
        assertEquals(Outcome.Refused(Refusal.OVER_MESSAGE_BUDGET), small)
        val huge = ImageResizePlan.shrink(ImageResizePlan.JPEG_STEPS, ImageResizePlan.MESSAGE_WIRE_BUDGET) { "x" to 9_000_000L }
        assertEquals(Outcome.Refused(Refusal.TOO_LARGE), huge)
    }

    @Test
    fun `a GIF is sent as is or refused`() {
        assertNull(ImageResizePlan.sendAsIs(10, 20))
        assertEquals(Refusal.OVER_MESSAGE_BUDGET, ImageResizePlan.sendAsIs(10, 5))
        assertEquals(Refusal.GIF_TOO_LARGE, ImageResizePlan.sendAsIs(ImageResizePlan.MESSAGE_WIRE_BUDGET + 1, ImageResizePlan.MESSAGE_WIRE_BUDGET))
    }

    @Test
    fun `EXIF orientation maps to rotation then mirror`() {
        assertEquals(ImageResizePlan.Orientation(0, false), ImageResizePlan.orientation(1))
        assertEquals(ImageResizePlan.Orientation(0, true), ImageResizePlan.orientation(2))
        assertEquals(ImageResizePlan.Orientation(180, false), ImageResizePlan.orientation(3))
        assertEquals(ImageResizePlan.Orientation(180, true), ImageResizePlan.orientation(4))
        assertEquals(ImageResizePlan.Orientation(90, true), ImageResizePlan.orientation(5))
        assertEquals(ImageResizePlan.Orientation(90, false), ImageResizePlan.orientation(6))
        assertEquals(ImageResizePlan.Orientation(270, true), ImageResizePlan.orientation(7))
        assertEquals(ImageResizePlan.Orientation(270, false), ImageResizePlan.orientation(8))
        assertEquals(ImageResizePlan.Orientation(0, false), ImageResizePlan.orientation(0))
        assertTrue(ImageResizePlan.orientation(6).swapsSides)
        assertFalse(ImageResizePlan.orientation(3).swapsSides)
    }

    @Test
    fun `refusal copy names the image like the other clients`() {
        assertEquals(
            "IMG_1.jpg is still over 3 MB after shrinking it to 1280 px",
            ImageResizePlan.refusalMessage("IMG_1.jpg", Refusal.TOO_LARGE),
        )
    }
}
