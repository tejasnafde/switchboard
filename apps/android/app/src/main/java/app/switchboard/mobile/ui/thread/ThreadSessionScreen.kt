package app.switchboard.mobile.ui.thread

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import app.switchboard.mobile.data.thread.ThreadSessionCoordinator
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.composer.OutboxUiAction
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.ui.navigation.ThreadViewingLeaseLifecycle
import java.io.Closeable
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
    onImagesSelected: (List<ComposerImageSource>) -> Unit = {},
    onRemoveImage: (String) -> Unit = {},
    queuedTurns: List<QueuedTurn> = emptyList(),
    onOutboxAction: (String, OutboxUiAction) -> Unit = { _, _ -> },
    composerError: String? = null,
    viewingLeaseLifecycle: ThreadViewingLeaseLifecycle? = null,
    registerViewingLeaseRenewal: ((() -> Unit) -> Closeable)? = null,
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
    ThreadViewingLeaseEffect(viewingLeaseLifecycle, registerViewingLeaseRenewal)
    ThreadScreen(
        threadId = threadId,
        title = title,
        backendLabel = backendLabel,
        loadState = session.load.toUiLoadState(),
        onRetry = coordinator::refresh,
        onAction = router::perform,
        onBack = onBack,
        modifier = modifier,
        composer = session.toComposerPresentation().let { presentation ->
            if (composerError == null) presentation else presentation.copy(error = composerError)
        },
        onDraftChange = coordinator::updateDraft,
        onSend = router::send,
        onInterrupt = router::interrupt,
        onRuntimeModeChange = router::selectRuntimeMode,
        models = session.models,
        onModelChange = coordinator::selectModel,
        onRefreshModels = coordinator::refreshModels,
        onClearLocalFeed = router::clearVisibleFeed,
        skills = session.skills,
        pendingActions = session.pendingActions,
        onImagesSelected = onImagesSelected,
        onRemoveImage = onRemoveImage,
        queuedTurns = queuedTurns,
        onOutboxAction = onOutboxAction,
    )
}

@Composable
private fun ThreadViewingLeaseEffect(
    owner: ThreadViewingLeaseLifecycle?,
    registerRenewal: ((() -> Unit) -> Closeable)?,
) {
    if (owner == null || registerRenewal == null) return
    val activity = LocalContext.current.findActivity()
    val lifecycleOwner = activity as? LifecycleOwner
    DisposableEffect(owner, registerRenewal, lifecycleOwner) {
        owner.onVisible()
        val renewal = registerRenewal(owner::onForegroundRenewal)
        val observer = LifecycleEventObserver { _, event ->
            if (
                event == Lifecycle.Event.ON_STOP &&
                activity?.isChangingConfigurations != true
            ) {
                owner.onBackground()
            }
        }
        lifecycleOwner?.lifecycle?.addObserver(observer)
        onDispose {
            lifecycleOwner?.lifecycle?.removeObserver(observer)
            renewal.close()
            owner.close()
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
