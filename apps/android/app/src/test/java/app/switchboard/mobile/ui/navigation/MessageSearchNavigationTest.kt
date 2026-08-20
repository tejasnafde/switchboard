package app.switchboard.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

class MessageSearchNavigationTest {
    @Test
    fun `search route stays bound to the selected machine`() {
        val route = AppRoute.MessageSearch("mac-a", "Studio Mac")
        val state = NavigationState.root().push(route)

        assertEquals(route, state.current)
        assertEquals(AppRoute.Connections, state.pop().current)
    }
}
