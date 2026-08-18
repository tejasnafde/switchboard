package app.switchboard.mobile.platform.notification

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationPermissionPolicyTest {
    @Test
    fun `pre Android 13 needs no runtime permission`() {
        assertEquals(
            NotificationPermissionDecision.Granted,
            NotificationPermissionPolicy.decide(apiLevel = 32, granted = false, askedBefore = false),
        )
    }

    @Test
    fun `Android 13 asks once and treats denial as nonfatal settings state`() {
        assertEquals(
            NotificationPermissionDecision.Request,
            NotificationPermissionPolicy.decide(apiLevel = 33, granted = false, askedBefore = false),
        )
        assertEquals(
            NotificationPermissionDecision.Denied,
            NotificationPermissionPolicy.decide(apiLevel = 33, granted = false, askedBefore = true),
        )
        assertEquals(
            NotificationPermissionDecision.Granted,
            NotificationPermissionPolicy.decide(apiLevel = 36, granted = true, askedBefore = true),
        )
    }
}
