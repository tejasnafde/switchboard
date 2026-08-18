package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.platform.protocol.TransportScope
import java.io.Closeable
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadViewingLeaseLifecycleTest {
    @Test
    fun `visible exact scope enters once background leaves and foreground reacquires`() {
        val expected = scope(4)
        var current: TransportScope? = expected
        val calls = mutableListOf<String>()
        val owner = ThreadViewingLeaseLifecycle(
            expectedScope = expected,
            threadId = "thread-1",
            currentScope = { current },
            begin = { leaseScope, threadId ->
                calls += "enter:${leaseScope.generation}:$threadId"
                Closeable { calls += "leave:${leaseScope.generation}:$threadId" }
            },
        )

        owner.onVisible()
        owner.onVisible()
        owner.onBackground()
        owner.onForegroundRenewal()

        assertEquals(
            listOf(
                "enter:4:thread-1",
                "leave:4:thread-1",
                "enter:4:thread-1",
            ),
            calls,
        )
    }

    @Test
    fun `stale generation cannot enter or survive a foreground callback`() {
        val expected = scope(7)
        var current: TransportScope? = expected
        val calls = mutableListOf<String>()
        val owner = ThreadViewingLeaseLifecycle(
            expectedScope = expected,
            threadId = "thread-2",
            currentScope = { current },
            begin = { leaseScope, threadId ->
                calls += "enter:${leaseScope.generation}:$threadId"
                Closeable { calls += "leave:${leaseScope.generation}:$threadId" }
            },
        )

        owner.onVisible()
        current = scope(8)
        owner.onForegroundRenewal()
        owner.onForegroundRenewal()

        assertEquals(listOf("enter:7:thread-2", "leave:7:thread-2"), calls)
    }

    @Test
    fun `route disposal is idempotent and fences late renewal`() {
        val expected = scope(9)
        val calls = mutableListOf<String>()
        val owner = ThreadViewingLeaseLifecycle(
            expectedScope = expected,
            threadId = "thread-3",
            currentScope = { expected },
            begin = { leaseScope, threadId ->
                calls += "enter:${leaseScope.generation}:$threadId"
                Closeable { calls += "leave:${leaseScope.generation}:$threadId" }
            },
        )

        owner.onVisible()
        owner.close()
        owner.close()
        owner.onForegroundRenewal()

        assertEquals(listOf("enter:9:thread-3", "leave:9:thread-3"), calls)
    }

    private fun scope(generation: Long) = TransportScope("phone", "machine", generation)
}
