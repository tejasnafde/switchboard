package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.thread.HtmlLivePages
import app.switchboard.mobile.domain.thread.HtmlLiveState
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HtmlLiveImagesTest {
    private class FakeRemote(
        private val state: RemoteOutcome<HtmlLiveState> = RemoteOutcome.Success(HtmlLiveState("data:image/png;base64,AA==", null)),
        private val opened: RemoteOutcome<Boolean> = RemoteOutcome.Success(true),
        private val reject: Boolean = false,
    ) : HtmlLiveRemote {
        val loads = mutableListOf<String>()
        val opens = mutableListOf<JsonObject>()
        private val key = RemoteRequestKey("c", 1, "op")

        override fun htmlLiveLoad(key: String, callback: (RemoteResponse<HtmlLiveState>) -> Unit): RequestSubmission {
            loads += key
            if (reject) return RequestSubmission.Rejected(RpcFailure.ConnectionReplaced)
            callback(RemoteResponse(this.key, state))
            return accepted()
        }

        override fun htmlLiveOpenOnDesktop(request: JsonObject, callback: (RemoteResponse<Boolean>) -> Unit): RequestSubmission {
            opens += request
            if (reject) return RequestSubmission.Rejected(RpcFailure.ConnectionReplaced)
            callback(RemoteResponse(key, opened))
            return accepted()
        }

        private fun accepted() = RequestSubmission.Accepted(1, TransportScope("d", "c", 1))
    }

    private val with = setOf(HtmlLivePages.CAPABILITY)

    @Test
    fun withoutTheCapabilityNothingIsSent() = runBlocking {
        val remote = FakeRemote()
        val images = HtmlLiveImages(emptySet(), "t1", remote)
        assertNull(images.load("k"))
        assertFalse(images.canOpenOnDesktop)
        assertFalse(images.openOnDesktop("<b>x</b>", null))
        assertTrue(remote.loads.isEmpty())
        assertTrue(remote.opens.isEmpty())
    }

    @Test
    fun loadAnswersTheStoredState() = runBlocking {
        val remote = FakeRemote()
        assertEquals("data:image/png;base64,AA==", HtmlLiveImages(with, "t1", remote).load("k")?.image)
        assertEquals(listOf("k"), remote.loads)
    }

    @Test
    fun aFailedOrRejectedLoadIsNoImage() = runBlocking {
        assertNull(HtmlLiveImages(with, "t1", FakeRemote(state = RemoteOutcome.Failure("down"))).load("k"))
        assertNull(HtmlLiveImages(with, "t1", FakeRemote(reject = true)).load("k"))
    }

    @Test
    fun openOnDesktopNeedsTheThreadAndSendsTheRequest() = runBlocking {
        val remote = FakeRemote()
        assertFalse(HtmlLiveImages(with, null, remote).canOpenOnDesktop)
        assertTrue(HtmlLiveImages(with, "t1", remote).openOnDesktop("<b>x</b>", "T"))
        assertEquals(JsonString("t1"), remote.opens.single().values["conversationId"])
        assertEquals(JsonString("T"), remote.opens.single().values["title"])
        assertFalse(HtmlLiveImages(with, "t1", FakeRemote(opened = RemoteOutcome.Failure("x"))).openOnDesktop("a", null))
        assertFalse(HtmlLiveImages(with, "t1", FakeRemote(reject = true)).openOnDesktop("a", null))
    }
}
