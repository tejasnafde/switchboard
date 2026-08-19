package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.MessageSearchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageSearchCoordinatorTest {
    @Test
    fun `two characters debounce once and a newer query fences an older response`() {
        val scheduler = ManualSearchScheduler()
        val remote = FakeMessageSearchRemote()
        val coordinator = MessageSearchCoordinator("mac", 7, remote, scheduler)

        coordinator.updateQuery("n")
        assertTrue(scheduler.pending.isEmpty())
        coordinator.updateQuery("native")
        scheduler.runNext()
        assertEquals(listOf("native"), remote.queries)
        assertTrue(coordinator.state.value.loading)

        coordinator.updateQuery("native sync")
        scheduler.runNext()
        remote.succeed(1, listOf(result("new")))
        remote.succeed(0, listOf(result("old")))

        assertEquals("native sync", coordinator.state.value.query)
        assertEquals(listOf("new"), coordinator.state.value.results.map { it.messageId })
        assertFalse(coordinator.state.value.loading)
    }

    @Test
    fun `wrong connection generation is ignored and results are bounded`() {
        val scheduler = ManualSearchScheduler()
        val remote = FakeMessageSearchRemote()
        val coordinator = MessageSearchCoordinator("mac", 7, remote, scheduler, resultLimit = 40)

        coordinator.updateQuery("native")
        scheduler.runNext()
        remote.succeed(
            0,
            (1..60).map { result("message-$it") },
            key = RemoteRequestKey("mac", 6, BackendChannels.SearchMessages),
        )
        assertTrue(coordinator.state.value.loading)

        coordinator.retry()
        remote.succeed(1, (1..60).map { result("message-$it") })
        assertEquals(40, coordinator.state.value.results.size)
    }

    @Test
    fun `retry repeats the current query immediately after failure`() {
        val scheduler = ManualSearchScheduler()
        val remote = FakeMessageSearchRemote()
        val coordinator = MessageSearchCoordinator("mac", 7, remote, scheduler)

        coordinator.updateQuery("native")
        scheduler.runNext()
        remote.fail(0, "offline")
        assertEquals("offline", coordinator.state.value.error)

        coordinator.retry()
        assertEquals(listOf("native", "native"), remote.queries)
        assertNull(coordinator.state.value.error)
        assertTrue(coordinator.state.value.loading)
    }

    @Test
    fun `synchronous submission rejection cannot leave search loading`() {
        val scheduler = ManualSearchScheduler()
        val remote = FakeMessageSearchRemote().apply {
            nextSubmission = RequestSubmission.Rejected(RpcFailure.NotReady)
        }
        val coordinator = MessageSearchCoordinator("mac", 7, remote, scheduler)

        coordinator.updateQuery("native")
        scheduler.runNext()

        assertFalse(coordinator.state.value.loading)
        assertEquals("Machine is not ready. Retry search.", coordinator.state.value.error)
    }

    @Test
    fun `callback buffered before a rejected submission cannot overwrite rejection`() {
        val scheduler = ManualSearchScheduler()
        val remote = FakeMessageSearchRemote().apply {
            nextSubmission = RequestSubmission.Rejected(RpcFailure.ConnectionReplaced)
            synchronousResponse = RemoteResponse(
                RemoteRequestKey("mac", 7, BackendChannels.SearchMessages),
                RemoteOutcome.Success(listOf(result("should-not-land"))),
            )
        }
        val coordinator = MessageSearchCoordinator("mac", 7, remote, scheduler)

        coordinator.updateQuery("native")
        scheduler.runNext()

        assertTrue(coordinator.state.value.results.isEmpty())
        assertEquals("Machine connection changed. Retry search.", coordinator.state.value.error)
    }

    private fun result(id: String) = MessageSearchResult(
        messageId = id,
        conversationId = "thread-$id",
        role = "assistant",
        content = "body",
        snippet = "body",
        conversationTitle = "Native app",
        projectPath = "/repo",
        agentType = "codex",
        worktreePath = null,
        worktreeBranch = null,
        raw = JsonObject(linkedMapOf()),
    )
}

private class ManualSearchScheduler : MessageSearchScheduler {
    val pending = ArrayDeque<() -> Unit>()

    override fun schedule(delayMillis: Long, action: () -> Unit): Cancelable {
        pending += action
        return Cancelable { pending.remove(action) }
    }

    fun runNext() = pending.removeFirst().invoke()
}

private class FakeMessageSearchRemote : MessageSearchRemote {
    data class Pending(
        val callback: (RemoteResponse<List<MessageSearchResult>>) -> Unit,
    )

    val queries = mutableListOf<String>()
    private val pending = mutableListOf<Pending>()
    var nextSubmission: RequestSubmission? = null
    var synchronousResponse: RemoteResponse<List<MessageSearchResult>>? = null

    override fun searchMessages(
        query: String,
        callback: (RemoteResponse<List<MessageSearchResult>>) -> Unit,
    ): RequestSubmission {
        queries += query
        pending += Pending(callback)
        synchronousResponse?.also(callback)
        return nextSubmission
            ?: RequestSubmission.Accepted(queries.size.toLong(), TransportScope("phone", "mac", 7))
    }

    fun succeed(
        index: Int,
        results: List<MessageSearchResult>,
        key: RemoteRequestKey = RemoteRequestKey("mac", 7, BackendChannels.SearchMessages),
    ) = pending[index].callback(RemoteResponse(key, RemoteOutcome.Success(results)))

    fun fail(index: Int, message: String) = pending[index].callback(
        RemoteResponse(
            RemoteRequestKey("mac", 7, BackendChannels.SearchMessages),
            RemoteOutcome.Failure(message),
        ),
    )
}
