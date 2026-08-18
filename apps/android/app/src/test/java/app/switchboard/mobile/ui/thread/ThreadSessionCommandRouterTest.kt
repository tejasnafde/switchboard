package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.remote.RuntimeMode
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadSessionCommandRouterTest {
    @Test
    fun `commands do not touch the coordinator until the injected dispatcher runs them`() {
        val port = FakeThreadSessionCommands()
        val pending = ArrayDeque<() -> Unit>()
        val router = ThreadSessionCommandRouter(
            commands = port,
            dispatcher = ThreadCommandDispatcher(pending::addLast),
        )
        val action = ThreadUiAction.OpenFile("edit", "/repo", "A.kt")

        router.send()
        router.perform(action)
        router.interrupt()
        router.selectRuntimeMode(RuntimeMode.Plan)

        assertTrueEvents(emptyList(), port.events)
        while (pending.isNotEmpty()) pending.removeFirst().invoke()
        assertTrueEvents(
            listOf("send", "action:$action", "interrupt", "mode:Plan"),
            port.events,
        )
    }

    private fun assertTrueEvents(expected: List<String>, actual: List<String>) {
        assertEquals(expected, actual)
    }
}

private class FakeThreadSessionCommands : ThreadSessionCommandPort {
    val events = mutableListOf<String>()

    override fun submit() {
        events += "send"
    }

    override fun perform(action: ThreadUiAction) {
        events += "action:$action"
    }

    override fun interrupt() {
        events += "interrupt"
    }

    override fun selectRuntimeMode(mode: RuntimeMode) {
        events += "mode:${mode.name}"
    }
}
