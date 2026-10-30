package app.switchboard.mobile.platform.log

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import app.switchboard.mobile.platform.share.ShareImage
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Shares the app log file through the system share sheet, as one text file. */
object ShareLog {
    const val FAILED = "Could not share the log"
    private const val PREFIX = "switchboard-log-"
    private const val KEEP_MS = 24L * 60 * 60 * 1000

    /**
     * Each share gets its own file, so an app that opens an earlier share
     * later still reads that snapshot; copies older than a day are removed.
     * Answers null when the sheet opened, else the line to show.
     */
    suspend fun share(context: Context): String? = try {
        val uri = withContext(Dispatchers.IO) {
            val dir = File(context.cacheDir, ShareImage.DIR).apply { mkdirs() }
            val now = System.currentTimeMillis()
            dir.listFiles { file -> file.name.startsWith(PREFIX) && now - file.lastModified() > KEEP_MS }
                ?.forEach(File::delete)
            val out = File(dir, "$PREFIX$now.txt")
            out.writeText(SbLog.readFile().ifEmpty { "No log lines yet.\n" })
            FileProvider.getUriForFile(context, ShareImage.authority(context), out)
        }
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, "Switchboard log")
            clipData = ClipData.newRawUri("Switchboard log", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, null)
        if (context !is Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
        null
    } catch (exception: Exception) {
        SbLog.w("log", "share failed: ${SbLog.describe(exception)}")
        FAILED
    }
}
