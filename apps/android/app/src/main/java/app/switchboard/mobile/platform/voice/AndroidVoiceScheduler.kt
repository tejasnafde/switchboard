package app.switchboard.mobile.platform.voice

import android.os.Handler
import android.os.Looper
import app.switchboard.mobile.domain.voice.VoiceCancelable
import app.switchboard.mobile.domain.voice.VoiceScheduler
import java.util.concurrent.atomic.AtomicBoolean

class AndroidVoiceScheduler(
    private val handler: Handler = Handler(Looper.getMainLooper()),
) : VoiceScheduler {
    override fun schedule(delayMs: Long, block: () -> Unit): VoiceCancelable {
        val cancelled = AtomicBoolean(false)
        val task = Runnable {
            if (!cancelled.get()) block()
        }
        handler.postDelayed(task, delayMs)
        return VoiceCancelable {
            if (cancelled.compareAndSet(false, true)) handler.removeCallbacks(task)
        }
    }
}
