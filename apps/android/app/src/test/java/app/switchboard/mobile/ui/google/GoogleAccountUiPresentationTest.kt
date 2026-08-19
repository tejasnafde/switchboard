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

    @Test
    fun `signed out recovery handles fresh installs without claiming prior credentials existed`() {
        assertEquals(
            "Google account not connected",
            GoogleAccountUiPresenter.recoveryTitle(GoogleAccountPresentation.SignedOut),
        )
        val detail = GoogleAccountUiPresenter.recoverySupportingText(
            GoogleAccountPresentation.SignedOut,
        )

        assertEquals(
            "No Google credentials were found. If you used Google in the previous app, reconnect from your Mac and scan its QR code.",
            detail,
        )
        assertFalse(detail.contains("saved credential", ignoreCase = true))
    }

    @Test
    fun `blocked recovery distinguishes unreadable credentials and directs safe reimport`() {
        assertEquals(
            "Credentials need attention",
            GoogleAccountUiPresenter.recoveryTitle(GoogleAccountPresentation.Blocked),
        )
        assertEquals(
            "Saved credentials are present but Android cannot read them. Re-import from Switchboard on your Mac; existing storage will not be deleted.",
            GoogleAccountUiPresenter.recoverySupportingText(GoogleAccountPresentation.Blocked),
        )
    }
}
