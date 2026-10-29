package app.switchboard.mobile.platform.share

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShareImageTest {
    private val context: Application = ApplicationProvider.getApplicationContext()
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)

    @Test
    fun theFileLandsInTheSharedCacheFolderUnderASafeName() {
        val file = ShareImage.writePng(context.cacheDir, "../My chart: Q3/2026", png)
        assertEquals(File(context.cacheDir, "shared"), file.parentFile)
        assertEquals("My-chart-Q3-2026.png", file.name)
        assertArrayEquals(png, file.readBytes())
        assertEquals("image.png", ShareImage.fileName("///"))
    }

    @Test
    fun theSendIntentCarriesThePngUriWithAReadGrant() {
        val uri = Uri.parse("content://app.switchboard.mobile.fileprovider/shared/x.png")
        val intent = ShareImage.sendIntent(uri, "Chart")
        assertEquals(Intent.ACTION_SEND, intent.action)
        assertEquals("image/png", intent.type)
        @Suppress("DEPRECATION")
        assertEquals(uri, intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }

    @Test
    fun shareWritesTheFileAndOpensTheChooserWithAContentUri() = runBlocking {
        assertNull(ShareImage.share(context, "Diagram") { png })
        val chooser = shadowOf(context).nextStartedActivity
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        @Suppress("DEPRECATION")
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("image/png", send.type)
        assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        @Suppress("DEPRECATION")
        val uri = send.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)!!
        assertEquals("content", uri.scheme)
        assertEquals(ShareImage.authority(context), uri.authority)
        assertArrayEquals(png, File(context.cacheDir, "shared/Diagram.png").readBytes())
    }

    @Test
    fun aFailedWriteAnswersTheLineToShow() = runBlocking {
        assertEquals(ShareImage.FAILED, ShareImage.share(context, "x") { error("no bytes") })
        assertNull(shadowOf(context).nextStartedActivity)
    }

    @Test
    fun onlyAPngSignatureCountsAsPng() {
        assertTrue(ShareImage.isPng(png))
        assertFalse(ShareImage.isPng(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())))
    }
}
