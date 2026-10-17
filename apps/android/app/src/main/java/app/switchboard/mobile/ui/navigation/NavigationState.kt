package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.platform.deeplink.AppDeepLinkRoute
import app.switchboard.mobile.platform.deeplink.PendingAppDeepLink
import app.switchboard.mobile.domain.reviews.WorkOnPrIntent
import java.io.Serializable

sealed interface AppRoute : Serializable {
    data object Connections : AppRoute

    data object ManageConnections : AppRoute

    data object Settings : AppRoute

    data object GoogleAccount : AppRoute

    data class MessageSearch(
        val connectionId: String,
        val connectionLabel: String,
    ) : AppRoute

    data class Pair(
        val editConnectionId: String? = null,
        val startManual: Boolean = false,
        /** Scan a new QR into [editConnectionId] instead of opening its form. */
        val rescan: Boolean = false,
        /** Open on the Cloud IAP list. */
        val startIap: Boolean = false,
    ) : AppRoute

    data class Browse(
        val connectionId: String,
        val connectionLabel: String,
        val projectPath: String? = null,
        val projectName: String? = null,
    ) : AppRoute {
        init {
            require((projectPath == null) == (projectName == null)) {
                "Browse project path and name must be present together"
            }
        }
    }

    data class Thread(
        val connectionId: String,
        val connectionLabel: String,
        val threadId: String,
        val projectPath: String,
        val worktreePath: String? = null,
        val title: String,
        val provider: String? = null,
    ) : AppRoute

    data class NewSession(
        val connectionId: String,
        val connectionLabel: String,
        val projectPath: String,
        val projectName: String,
        /** Reviews > Work on PR > Start a chat. */
        val workOnPr: WorkOnPrIntent? = null,
    ) : AppRoute

    /** A connection's Reviews tab; the Projects tab is [Browse] without a project. */
    data class Reviews(
        val connectionId: String,
        val connectionLabel: String,
    ) : AppRoute

    data class PullRequest(
        val connectionId: String,
        val connectionLabel: String,
        val host: String,
        val owner: String,
        val name: String,
        val number: Long,
    ) : AppRoute
}

@ConsistentCopyVisibility
data class NavigationState private constructor(
    val backStack: List<AppRoute>,
) : Serializable {
    init {
        require(backStack.isNotEmpty()) { "Navigation stack cannot be empty" }
        require(backStack.first() == AppRoute.Connections) {
            "Navigation stack must start at Connections"
        }
    }

    val current: AppRoute
        get() = backStack.last()

    val canGoBack: Boolean
        get() = backStack.size > 1

    fun push(route: AppRoute): NavigationState = copy(backStack = backStack + route)

    fun replace(route: AppRoute): NavigationState = copy(
        backStack = backStack.dropLast(1) + route,
    )

    fun pop(): NavigationState =
        if (canGoBack) copy(backStack = backStack.dropLast(1)) else this

    companion object {
        fun root(): NavigationState = NavigationState(listOf(AppRoute.Connections))
    }
}

object AppDeepLinkNavigationResolver {
    fun resolve(pending: PendingAppDeepLink): NavigationState = when (pending.route) {
        AppDeepLinkRoute.Settings -> NavigationState.root().push(AppRoute.Settings)
    }
}
