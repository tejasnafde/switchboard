package app.switchboard.mobile.ui.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeBackGesturePolicyTest {
    @Test
    fun `gesture must begin within the exact 32dp left edge`() {
        assertTrue(EdgeBackGesturePolicy.shouldClaim(32f, 13f, 0f))
        assertFalse(EdgeBackGesturePolicy.shouldClaim(32.01f, 100f, 0f))
    }

    @Test
    fun `claim requires rightward travel beyond 12dp and horizontal dominance`() {
        assertFalse(EdgeBackGesturePolicy.shouldClaim(0f, 11.99f, 0f))
        assertTrue(EdgeBackGesturePolicy.shouldClaim(0f, 12f, 7.99f))
        assertFalse(EdgeBackGesturePolicy.shouldClaim(0f, 12f, 8f))
        assertFalse(EdgeBackGesturePolicy.shouldClaim(0f, -20f, 0f))
    }

    @Test
    fun `release commits at 80dp or a 500dp per second flick`() {
        assertTrue(EdgeBackGesturePolicy.commits(80f, 0f))
        assertTrue(EdgeBackGesturePolicy.commits(20f, 500f))
        assertFalse(EdgeBackGesturePolicy.commits(79.99f, 499.99f))
        assertFalse(EdgeBackGesturePolicy.commits(-100f, -500f))
    }
}
