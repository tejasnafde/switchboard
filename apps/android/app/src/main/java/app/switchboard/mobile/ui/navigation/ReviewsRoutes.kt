package app.switchboard.mobile.ui.navigation

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.remote.PullRequestDetailCoordinator
import app.switchboard.mobile.data.remote.PullRequestDetailState
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.ReviewsCoordinator
import app.switchboard.mobile.data.remote.ReviewsState
import app.switchboard.mobile.data.remote.SwitchboardReviewsRemote
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.reviews.PhonePullRequests
import app.switchboard.mobile.domain.reviews.PhoneReviewPill
import app.switchboard.mobile.domain.reviews.PrDetail
import app.switchboard.mobile.domain.reviews.PrLinkChat
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.PullRequestRefresh
import app.switchboard.mobile.domain.reviews.WorkOnPr
import app.switchboard.mobile.domain.reviews.WorkOnPrPlan
import app.switchboard.mobile.ui.reviews.ConnectionTab
import app.switchboard.mobile.ui.reviews.ConnectionTabBar
import app.switchboard.mobile.ui.reviews.PullRequestDetailScreen
import app.switchboard.mobile.ui.reviews.ReviewsScreen
import kotlinx.coroutines.delay

private const val TAG = "Reviews"

/**
 * One [ReviewsCoordinator] per connection generation, kept across the
 * Projects and Reviews tabs and the detail screen, so going back shows the
 * last list at once and the refresh rule (not a re-mount) decides when to read.
 */
class ReviewsCoordinatorRegistry {
    private val coordinators = mutableMapOf<String, ReviewsCoordinator>()

    @Synchronized
    fun get(connectionId: String, lease: ReadyClientLease, runtime: RootNavigationRuntime, snapshot: OfflineSnapshot): ReviewsCoordinator {
        val key = "$connectionId:${lease.scope.generation}"
        return coordinators.getOrPut(key) {
            coordinators.keys.removeAll { it.startsWith("$connectionId:") }
            ReviewsCoordinator(
                connectionId = connectionId,
                generation = lease.scope.generation,
                remote = SwitchboardReviewsRemote(lease.client),
                clock = System::currentTimeMillis,
                initialFilters = runtime.reviewFilters(connectionId, snapshot),
                saveFilters = { runtime.saveReviewFilters(connectionId, it) },
                log = { Log.w(TAG, it) },
            )
        }
    }
}

/** Reads on open, on resume (focus) and every 5 minutes while the connection's tabs are visible. */
@Composable
private fun ReviewsRefreshEffect(coordinator: ReviewsCoordinator) {
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(coordinator, lifecycleOwner) {
        coordinator.setVisible(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        coordinator.refresh(PullRequestRefresh.Reason.Open)
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> {
                    coordinator.setVisible(true)
                    coordinator.refresh(PullRequestRefresh.Reason.Focus)
                }
                Lifecycle.Event.ON_PAUSE -> coordinator.setVisible(false)
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            coordinator.setVisible(false)
        }
    }
    LaunchedEffect(coordinator) {
        while (true) {
            delay(coordinator.nextRefreshDelay().coerceAtLeast(1_000))
            coordinator.refresh(PullRequestRefresh.Reason.Interval)
        }
    }
}

@Composable
private fun rememberNow(): Long {
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(30_000)
            value = System.currentTimeMillis()
        }
    }
    return now
}

/** The Projects tab: the existing project list with the connection's tab bar under it. */
@Composable
internal fun ProjectsTabHost(
    connectionId: String,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    snapshot: OfflineSnapshot,
    registry: ReviewsCoordinatorRegistry,
    onTab: (ConnectionTab) -> Unit,
    content: @Composable () -> Unit,
) {
    val lease = remember(runtime, connectionId, status) { runtime?.lease(connectionId) }
    val needsYou = if (runtime != null && lease != null) {
        val coordinator = remember(registry, lease.scope) { registry.get(connectionId, lease, runtime, snapshot) }
        ReviewsRefreshEffect(coordinator)
        val state by coordinator.state.collectAsState()
        state.needsYou(rememberNow())
    } else {
        0
    }
    Column(modifier = Modifier.fillMaxSize()) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) { content() }
        ConnectionTabBar(ConnectionTab.Projects, needsYou, onTab)
    }
}

private fun ReviewsState.needsYou(now: Long): Int =
    data?.let { PhonePullRequests.needsYouCount(it.prs, it.hidden, now) } ?: 0

@Composable
internal fun ReviewsRouteHost(
    route: AppRoute.Reviews,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    snapshot: OfflineSnapshot,
    registry: ReviewsCoordinatorRegistry,
    onTab: (ConnectionTab) -> Unit,
    onOpen: (PrSummary) -> Unit,
    onBack: () -> Unit,
) {
    val lease = remember(runtime, route.connectionId, status) { runtime?.lease(route.connectionId) }
    val now = rememberNow()
    val coordinator = if (runtime != null && lease != null) {
        remember(registry, lease.scope) { registry.get(route.connectionId, lease, runtime, snapshot) }
            .also { ReviewsRefreshEffect(it) }
    } else {
        null
    }
    val state = coordinator?.state?.collectAsState()?.value ?: ReviewsState(
        error = when (val fallback = RootNavigationPolicy.fallback(status)) {
            LeaseFallback.Loading -> null
            is LeaseFallback.Retryable -> fallback.message
        },
    )
    Column(modifier = Modifier.fillMaxSize()) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            ReviewsScreen(
                state = state,
                connectionLabel = route.connectionLabel,
                now = now,
                onBack = onBack,
                onRefresh = {
                    coordinator?.refresh(PullRequestRefresh.Reason.Manual) ?: runtime?.retry(route.connectionId)
                },
                onQuery = { coordinator?.setQuery(it) },
                onFilters = { coordinator?.setFilters(it) },
                onUnhideRepos = { coordinator?.unhideRepos() },
                onOpen = onOpen,
            )
        }
        ConnectionTabBar(ConnectionTab.Reviews, state.needsYou(now), onTab)
    }
}

@Composable
internal fun PullRequestRouteHost(
    route: AppRoute.PullRequest,
    runtime: RootNavigationRuntime?,
    status: ConnectionRuntimeState?,
    onBack: () -> Unit,
    onOpenChat: (PrLinkChat, PhoneReviewPill?) -> Unit,
    onStartChat: (PrDetail, WorkOnPrPlan) -> Unit,
) {
    val context = LocalContext.current
    val lease = remember(runtime, route.connectionId, status) { runtime?.lease(route.connectionId) }
    val now = rememberNow()
    val openUrl: (String) -> Unit = { url ->
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (error: ActivityNotFoundException) {
            Log.w(TAG, "no browser for the pull request url", error)
        }
    }
    if (runtime == null || lease == null) {
        PullRequestDetailScreen(
            state = PullRequestDetailState(
                loading = false,
                error = when (val fallback = RootNavigationPolicy.fallback(status)) {
                    LeaseFallback.Loading -> "Connecting to ${route.connectionLabel}"
                    is LeaseFallback.Retryable -> fallback.message
                },
            ),
            plan = null,
            now = now,
            onBack = onBack,
            onRetry = { runtime?.retry(route.connectionId) },
            onOpenUrl = openUrl,
            onOpenChat = { _, _ -> },
            onStartChat = { _, _ -> },
            onLoadLinkableChats = {},
        )
        return
    }
    val coordinator = remember(route, lease.scope) {
        PullRequestDetailCoordinator(
            connectionId = route.connectionId,
            generation = lease.scope.generation,
            ref = route.ref,
            remote = SwitchboardReviewsRemote(lease.client),
            log = { Log.w(TAG, it) },
        )
    }
    LaunchedEffect(coordinator) { coordinator.load() }
    val state by coordinator.state.collectAsState()
    val plan = state.detail?.let { WorkOnPr.plan(it.summary, lease.capabilities) }
    PullRequestDetailScreen(
        state = state,
        plan = plan,
        now = now,
        onBack = onBack,
        onRetry = coordinator::load,
        onOpenUrl = openUrl,
        onOpenChat = onOpenChat,
        onStartChat = onStartChat,
        onLoadLinkableChats = coordinator::loadLinkableChats,
    )
}

internal val AppRoute.PullRequest.ref: PrRef get() = PrRef(host, owner, name, number)
