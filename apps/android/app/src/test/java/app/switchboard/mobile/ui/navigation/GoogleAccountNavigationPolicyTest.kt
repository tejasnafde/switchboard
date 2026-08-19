package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.connections.GoogleAccountAvatarPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleAccountNavigationPolicyTest {
    @Test
    fun `only a verified signed-in presentation satisfies IAP pairing`() {
        assertTrue(
            GoogleAccountNavigationPolicy.isReady(
                GoogleAccountPresentation.SignedIn("person@example.com"),
            ),
        )
        assertTrue(
            GoogleAccountNavigationPolicy.isReady(GoogleAccountPresentation.SignedIn(null)),
        )
        assertFalse(GoogleAccountNavigationPolicy.isReady(GoogleAccountPresentation.SignedOut))
        assertFalse(GoogleAccountNavigationPolicy.isReady(GoogleAccountPresentation.Blocked))
    }

    @Test
    fun `QR unavailable notice is fixed informational copy directing users to paste`() {
        assertEquals(
            "QR scanning is not available in this native build yet. Paste the credential code below.",
            GoogleAccountNavigationPolicy.QrUnavailableNotice,
        )
        assertFalse(
            GoogleAccountNavigationPolicy.QrUnavailableNotice.contains("failed", ignoreCase = true),
        )
    }

    @Test
    fun `account avatar keeps initials only for a signed in identity`() {
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
        assertNull(GoogleAccountAvatarPolicy.monogramOrNull(GoogleAccountPresentation.SignedOut))
        assertNull(GoogleAccountAvatarPolicy.monogramOrNull(GoogleAccountPresentation.Blocked))
    }
}
