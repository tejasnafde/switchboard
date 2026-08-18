package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.data.thread.ThreadSessionCoordinator
import app.switchboard.mobile.domain.remote.RuntimeMode

fun interface ThreadCommandDispatcher {
    fun dispatch(command: () -> Unit)
}

interface ThreadSessionCommandPort {
    fun submit()

    fun perform(action: ThreadUiAction)

    fun interrupt()

    fun selectRuntimeMode(mode: RuntimeMode)

    fun clearVisibleFeed()
}

class CoordinatorThreadSessionCommandPort(
    private val coordinator: ThreadSessionCoordinator,
) : ThreadSessionCommandPort {
    override fun submit() {
        coordinator.submit()
    }

    override fun perform(action: ThreadUiAction) {
        coordinator.perform(action.toSessionControl())
    }

    override fun interrupt() = coordinator.interrupt()

    override fun selectRuntimeMode(mode: RuntimeMode) = coordinator.selectRuntimeMode(mode)

    override fun clearVisibleFeed() = coordinator.clearVisibleFeed()
}

class ThreadSessionCommandRouter(
    private val commands: ThreadSessionCommandPort,
    private val dispatcher: ThreadCommandDispatcher,
) {
    fun send() = dispatcher.dispatch(commands::submit)

    fun perform(action: ThreadUiAction) = dispatcher.dispatch { commands.perform(action) }

    fun interrupt() = dispatcher.dispatch(commands::interrupt)

    fun selectRuntimeMode(mode: RuntimeMode) = dispatcher.dispatch {
        commands.selectRuntimeMode(mode)
    }

    fun clearVisibleFeed() = dispatcher.dispatch(commands::clearVisibleFeed)
}
