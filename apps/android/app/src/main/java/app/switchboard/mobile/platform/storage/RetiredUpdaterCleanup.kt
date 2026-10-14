package app.switchboard.mobile.platform.storage

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Removes what the in-app APK updater left behind before Play became the only
 * update channel: its two preference files and staged APKs.
 */
object RetiredUpdaterCleanup {
    private const val TAG = "SwitchboardStorage"
    private val PREFERENCES = listOf("switchboard_update_state_v1", "switchboard_pending_installation_v1")
    private const val STAGING_DIRECTORY = "updates"

    fun run(context: Context) {
        Thread({
            try {
                PREFERENCES.forEach(context::deleteSharedPreferences)
                val staging = File(context.cacheDir, STAGING_DIRECTORY)
                if (!staging.deleteRecursively() && staging.exists()) {
                    Log.w(TAG, "retired updater cleanup left cache/$STAGING_DIRECTORY in place")
                }
            } catch (error: Exception) {
                Log.w(TAG, "retired updater cleanup failed: ${error.javaClass.simpleName}")
            }
        }, "switchboard-updater-cleanup").apply { isDaemon = true }.start()
    }
}
