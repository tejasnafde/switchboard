package app.switchboard.mobile.ui.navigation

import java.io.Serializable

sealed interface AppRoute : Serializable {
    data object Connections : AppRoute

    data class Pair(
        val editConnectionId: String? = null,
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
        val title: String,
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

    fun pop(): NavigationState =
        if (canGoBack) copy(backStack = backStack.dropLast(1)) else this

    companion object {
        fun root(): NavigationState = NavigationState(listOf(AppRoute.Connections))
    }
}
