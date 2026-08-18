package app.switchboard.mobile.ui.thread

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import app.switchboard.mobile.data.thread.ThreadSessionCoordinator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

private val ProcessThreadCommandDispatcher = run {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    ThreadCommandDispatcher { command -> scope.launch { command() } }
}

@Composable
fun ThreadSessionScreen(
    coordinator: ThreadSessionCoordinator,
    threadId: String,
    title: String,
    backendLabel: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    commandDispatcher: ThreadCommandDispatcher? = null,
) {
    val session by coordinator.state.collectAsState()
    val router = remember(coordinator, commandDispatcher) {
        ThreadSessionCommandRouter(
            commands = CoordinatorThreadSessionCommandPort(coordinator),
            dispatcher = commandDispatcher ?: ProcessThreadCommandDispatcher,
        )
    }
    DisposableEffect(coordinator) {
        coordinator.start()
        onDispose(coordinator::close)
    }
    ThreadScreen(
        threadId = threadId,
        title = title,
        backendLabel = backendLabel,
        loadState = session.load.toUiLoadState(),
        onRetry = coordinator::refresh,
        onAction = router::perform,
        onBack = onBack,
        modifier = modifier,
        composer = session.toComposerPresentation(),
        onDraftChange = coordinator::updateDraft,
        onSend = router::send,
        onInterrupt = router::interrupt,
        onRuntimeModeChange = router::selectRuntimeMode,
    )
}
