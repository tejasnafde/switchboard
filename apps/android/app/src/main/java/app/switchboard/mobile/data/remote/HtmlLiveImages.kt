package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.thread.HtmlLivePages
import app.switchboard.mobile.domain.thread.HtmlLiveState
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.protocol.JsonObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

interface HtmlLiveRemote {
    fun htmlLiveLoad(key: String, callback: (RemoteResponse<HtmlLiveState>) -> Unit): RequestSubmission

    fun htmlLiveOpenOnDesktop(request: JsonObject, callback: (RemoteResponse<String>) -> Unit): RequestSubmission
}

/**
 * A chat's inline live pages on the phone: the still images the desktop
 * stored, and Open on desktop. The phone never runs a page. Nothing is sent
 * unless the backend advertises `html_live_images_v1`.
 */
class HtmlLiveImages(
    capabilities: Set<String>,
    private val threadId: String?,
    private val remote: HtmlLiveRemote,
) {
    val available: Boolean = HtmlLivePages.CAPABILITY in capabilities
    val canOpenOnDesktop: Boolean get() = available && !threadId.isNullOrEmpty()

    /** The stored state for [key]; null without the capability or when the call fails. */
    suspend fun load(key: String): HtmlLiveState? {
        if (!available) return null
        return await(null) { done -> remote.htmlLiveLoad(key) { done((it.outcome as? RemoteOutcome.Success)?.value) } }
    }

    /** Asks the desktop to open the page in its pane; answers the line to show (see [HtmlLivePages.decodeOpened]). */
    suspend fun openOnDesktop(source: String, title: String?): String {
        val conversationId = threadId?.takeIf { canOpenOnDesktop } ?: return HtmlLivePages.UNREACHABLE
        return await(HtmlLivePages.UNREACHABLE) { done ->
            remote.htmlLiveOpenOnDesktop(HtmlLivePages.openRequest(conversationId, source, title)) {
                done((it.outcome as? RemoteOutcome.Success)?.value ?: HtmlLivePages.UNREACHABLE)
            }
        }
    }

    /** One answer per call: a rejected submission may never call back, so it answers [rejected]. */
    private suspend fun <T> await(rejected: T, submit: ((T) -> Unit) -> RequestSubmission): T =
        suspendCancellableCoroutine { continuation ->
            val answered = AtomicBoolean(false)
            val done = { value: T -> if (answered.compareAndSet(false, true)) continuation.resume(value) }
            if (submit(done) is RequestSubmission.Rejected) done(rejected)
        }
}
