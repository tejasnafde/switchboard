package app.switchboard.mobile.ui.google

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleAccountUiPresentationTest {
    @Test
    fun `signed in presentation uses email or a generic connected label`() {
        assertEquals(
            "person@example.com",
            GoogleAccountUiPresenter.accountValue(
                GoogleAccountPresentation.SignedIn("person@example.com"),
            ),
        )
        assertEquals(
            "Google account connected",
            GoogleAccountUiPresenter.accountValue(GoogleAccountPresentation.SignedIn(null)),
        )
    }

    @Test
    fun `blocked presentation is fixed and keeps credential recovery available`() {
        assertEquals(
            "Saved Google account credentials cannot be read on this device.",
            GoogleAccountUiPresenter.visibleError(GoogleAccountPresentation.Blocked, null),
        )
        assertTrue(GoogleAccountUiPresenter.showsCredentialImport(GoogleAccountPresentation.Blocked))
        assertTrue(
            GoogleAccountUiPresenter.showsCredentialImport(GoogleAccountPresentation.SignedOut),
        )
        assertFalse(
            GoogleAccountUiPresenter.showsCredentialImport(
                GoogleAccountPresentation.SignedIn("person@example.com"),
            ),
        )
    }

    @Test
    fun `operation and disclosure semantics describe state without secrets`() {
        assertEquals("Expanded", GoogleAccountAccessibilityPolicy.detailsState(expanded = true))
        assertEquals("Collapsed", GoogleAccountAccessibilityPolicy.detailsState(expanded = false))
        assertEquals(
            "Importing credentials",
            GoogleAccountAccessibilityPolicy.importState(
                hasCredentialDraft = true,
                operation = GoogleAccountUiOperation.Importing(3),
            ),
        )
        assertEquals(
            "Paste credentials to enable import",
            GoogleAccountAccessibilityPolicy.importState(
                hasCredentialDraft = false,
                operation = GoogleAccountUiOperation.Idle,
            ),
        )
        assertEquals(
            "Signing out",
            GoogleAccountAccessibilityPolicy.signOutState(
                GoogleAccountUiOperation.SigningOut(4),
            ),
        )
    }

    @Test
    fun `blocked state semantics never contain a storage reason`() {
        val description = GoogleAccountAccessibilityPolicy.accountState(
            GoogleAccountPresentation.Blocked,
        )

        assertEquals("Blocked", description)
        assertFalse(description.contains("token", ignoreCase = true))
    }

    @Test
    fun `account summary keeps identity and readiness copy concise`() {
        val account = GoogleAccountPresentation.SignedIn("tejas@example.com")

        assertEquals("TE", GoogleAccountUiPresenter.monogram(account))
        assertEquals("tejas@example.com", GoogleAccountUiPresenter.identity(account))
        assertEquals("Ready for Google IAP", GoogleAccountUiPresenter.statusTitle(account))
        assertEquals(
            "Credentials are encrypted on this device and used only when connecting.",
            GoogleAccountUiPresenter.statusSupportingText(account),
        )
    }
}
