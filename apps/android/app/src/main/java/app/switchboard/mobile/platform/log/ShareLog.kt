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
    private const val FILE_NAME = "switchboard-log.txt"

    suspend fun share(context: Context) {
        try {
            val uri = withContext(Dispatchers.IO) {
                val dir = File(context.cacheDir, ShareImage.DIR).apply { mkdirs() }
                val out = File(dir, FILE_NAME)
                out.writeText(SbLog.readFile().ifEmpty { "No log lines yet.\n" })
                FileProvider.getUriForFile(context, ShareImage.authority(context), out)
            }
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, "Switchboard log")
                clipData = ClipData.newRawUri(FILE_NAME, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, null)
            if (context !is Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(chooser)
        } catch (exception: Exception) {
            SbLog.w("log", "share failed: ${SbLog.describe(exception)}")
        }
    }
}
