package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GoogleAccountAvatarPolicyTest {
    @Test
    fun `signed out and blocked accounts use the standard account icon`() {
        assertNull(GoogleAccountAvatarPolicy.monogramOrNull(GoogleAccountPresentation.SignedOut))
        assertNull(GoogleAccountAvatarPolicy.monogramOrNull(GoogleAccountPresentation.Blocked))
    }

    @Test
    fun `signed in accounts retain concise identity initials`() {
        assertEquals(
            "TN",
            GoogleAccountAvatarPolicy.monogramOrNull(
                GoogleAccountPresentation.SignedIn("tejas.nafde@example.com"),
            ),
        )
        assertEquals(
            "TE",
            GoogleAccountAvatarPolicy.monogramOrNull(
                GoogleAccountPresentation.SignedIn("tejas@example.com"),
            ),
        )
    }
}
