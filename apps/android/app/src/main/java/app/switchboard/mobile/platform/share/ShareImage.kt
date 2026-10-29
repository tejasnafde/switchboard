package app.switchboard.mobile.platform.share

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "ShareImage"

/**
 * Shares a PNG through the system share sheet: the bytes go to
 * `cacheDir/shared/<name>.png` and leave the app as a FileProvider content
 * Uri with a one-off read grant.
 */
object ShareImage {
    const val DIR = "shared"
    const val MIME = "image/png"
    const val FAILED = "Could not share the image"
    private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    fun authority(context: Context): String = "${context.packageName}.fileprovider"

    /** A file name made only of letters, digits, `-` and `_`, never empty. */
    fun fileName(name: String): String {
        val safe = name.replace(Regex("[^A-Za-z0-9_-]+"), "-").trim('-').take(60)
        return "${safe.ifEmpty { "image" }}.png"
    }

    fun isPng(bytes: ByteArray): Boolean =
        bytes.size >= PNG_SIGNATURE.size && PNG_SIGNATURE.indices.all { bytes[it] == PNG_SIGNATURE[it] }

    fun encodePng(bitmap: Bitmap): ByteArray =
        ByteArrayOutputStream().use { out ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) { "PNG encode failed" }
            out.toByteArray()
        }

    /** Writes [png] to `cacheDir/shared/`, replacing a file of the same name. */
    fun writePng(cacheDir: File, name: String, png: ByteArray): File {
        val dir = File(cacheDir, DIR).apply { mkdirs() }
        return File(dir, fileName(name)).apply { writeBytes(png) }
    }

    fun sendIntent(uri: Uri, title: String): Intent = Intent(Intent.ACTION_SEND).apply {
        type = MIME
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, title)
        clipData = ClipData.newRawUri(title, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    /**
     * Writes the PNG off the main thread and opens the share sheet. Answers
     * null when the sheet opened, else the line to show; the cause is logged.
     */
    suspend fun share(context: Context, name: String, png: () -> ByteArray): String? = runCatching {
        val uri = withContext(Dispatchers.IO) {
            FileProvider.getUriForFile(context, authority(context), writePng(context.cacheDir, name, png()))
        }
        val chooser = Intent.createChooser(sendIntent(uri, name), null)
        if (context !is Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
    }.fold(
        onSuccess = { null },
        onFailure = {
            Log.w(TAG, "share failed", it)
            FAILED
        },
    )
}
