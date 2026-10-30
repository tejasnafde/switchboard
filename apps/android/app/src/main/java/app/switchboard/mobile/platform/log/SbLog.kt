package app.switchboard.mobile.platform.log

import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * The app's logger. Every line goes to logcat under the one tag [TAG], in
 * release builds too, and to a small rotating file that Settings can share.
 * Lines name state, ids and exception classes, never a token, key or secret.
 */
object SbLog {
    const val TAG = "SB"

    fun interface Sink {
        fun write(priority: Int, scope: String, message: String, error: Throwable?)
    }

    @Volatile
    var sink: Sink = LogcatSink

    @Volatile
    private var file: RotatingLogFile? = null

    /** Starts the file copy of the log under [directory]; a second call keeps the first. */
    @Synchronized
    fun installFile(directory: File) {
        if (file == null) file = RotatingLogFile(directory)
    }

    /** The whole file copy, oldest line first, or empty when it is off. */
    fun readFile(): String = file?.read().orEmpty()

    fun d(scope: String, message: String) = write(Log.DEBUG, scope, message, null)
    fun i(scope: String, message: String) = write(Log.INFO, scope, message, null)
    fun w(scope: String, message: String, error: Throwable? = null) = write(Log.WARN, scope, message, error)
    fun e(scope: String, message: String, error: Throwable? = null) = write(Log.ERROR, scope, message, error)

    /** `IllegalStateException: Cannot access database on the main thread`, no stack. */
    fun describe(error: Throwable): String = "${error.javaClass.simpleName}: ${error.message.orEmpty()}"

    private fun write(priority: Int, scope: String, message: String, error: Throwable?) {
        sink.write(priority, scope, message, error)
        file?.append(priority, scope, message, error)
    }

    private object LogcatSink : Sink {
        override fun write(priority: Int, scope: String, message: String, error: Throwable?) {
            val line = "[$scope] $message"
            try {
                Log.println(priority, TAG, if (error == null) line else "$line\n${Log.getStackTraceString(error)}")
            } catch (_: RuntimeException) {
                // JVM unit tests run against the android.jar stubs, which throw.
                System.err.println("$TAG $line${error?.let { " ${describe(it)}" }.orEmpty()}")
            }
        }
    }
}

/** Two files of at most [maxBytes] each, written on one background thread. */
internal class RotatingLogFile(
    private val directory: File,
    private val maxBytes: Long = 256L * 1024,
) {
    private val writer = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "sb-log").apply { isDaemon = true }
    }
    private val current = File(directory, "switchboard.log")
    private val previous = File(directory, "switchboard.log.1")
    private val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    /** Read on the writer thread, so a rotation cannot move a file under the read. */
    fun read(): String = writer.submit<String> {
        listOf(previous, current).filter(File::exists).joinToString("") { it.readText() }
    }.get()

    fun append(priority: Int, scope: String, message: String, error: Throwable?) {
        val stamp = System.currentTimeMillis()
        writer.execute {
            try {
                directory.mkdirs()
                if (current.length() > maxBytes) {
                    previous.delete()
                    current.renameTo(previous)
                }
                val level = "VVDIWEA".getOrElse(priority) { '?' }
                val cause = error?.let { " (${SbLog.describe(it)})" }.orEmpty()
                current.appendText("${time.format(Date(stamp))} $level [$scope] $message$cause\n")
            } catch (exception: Exception) {
                System.err.println("${SbLog.TAG} log file write failed: ${SbLog.describe(exception)}")
            }
        }
    }
}
