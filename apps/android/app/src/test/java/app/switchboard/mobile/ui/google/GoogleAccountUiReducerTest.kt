package app.switchboard.mobile.ui.google

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleCredentialImportResult
import app.switchboard.mobile.platform.google.GoogleRemoteRevokeResult
import app.switchboard.mobile.platform.google.GoogleSignOutResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleAccountUiReducerTest {
    @Test
    fun `sign out requires confirmation and exposes stable progress state`() {
        val initial = GoogleAccountUiReducer.initial(
            GoogleAccountPresentation.SignedIn("person@example.com"),
        )

        val requested = GoogleAccountUiReducer.reduce(
            initial,
            GoogleAccountUiEvent.SignOutRequested,
        )
        assertTrue(requested.signOutConfirmationVisible)
        assertEquals(GoogleAccountUiOperation.Idle, requested.operation)

        val confirmed = GoogleAccountUiReducer.reduce(
            requested,
            GoogleAccountUiEvent.SignOutConfirmed,
        )
        assertFalse(confirmed.signOutConfirmationVisible)
        assertEquals(GoogleAccountUiOperation.SigningOut(generation = 1), confirmed.operation)
        assertNull(confirmed.errorMessage)
    }

    @Test
    fun `successful import adopts the verified account and stale completion cannot replace it`() {
        val initial = GoogleAccountUiReducer.initial(GoogleAccountPresentation.SignedOut)
        val first = GoogleAccountUiReducer.reduce(initial, GoogleAccountUiEvent.ImportStarted)
        val replaced = GoogleAccountUiReducer.reduce(
            first,
            GoogleAccountUiEvent.AccountChanged(
                GoogleAccountPresentation.SignedIn("newer@example.com"),
            ),
        )

        val stale = GoogleAccountUiReducer.reduce(
            replaced,
            GoogleAccountUiEvent.ImportCompleted(
                generation = 1,
                result = GoogleCredentialImportResult.Success("old@example.com"),
            ),
        )

        assertEquals(replaced, stale)
        assertEquals(
            GoogleAccountPresentation.SignedIn("newer@example.com"),
            stale.account,
        )
    }

    @Test
    fun `accepted import success clears progress and presents email`() {
        val importing = GoogleAccountUiReducer.reduce(
            GoogleAccountUiReducer.initial(GoogleAccountPresentation.SignedOut),
            GoogleAccountUiEvent.ImportStarted,
        )

        val completed = GoogleAccountUiReducer.reduce(
            importing,
            GoogleAccountUiEvent.ImportCompleted(
                generation = 1,
                result = GoogleCredentialImportResult.Success("person@example.com"),
            ),
        )

        assertEquals(GoogleAccountUiOperation.Idle, completed.operation)
        assertEquals(
            GoogleAccountPresentation.SignedIn("person@example.com"),
            completed.account,
        )
        assertNull(completed.errorMessage)
    }

    @Test
    fun `import failures use fixed nonsecret copy`() {
        val importing = GoogleAccountUiReducer.reduce(
            GoogleAccountUiReducer.initial(GoogleAccountPresentation.SignedOut),
            GoogleAccountUiEvent.ImportStarted,
        )

        val failed = GoogleAccountUiReducer.reduce(
            importing,
            GoogleAccountUiEvent.ImportCompleted(
                generation = 1,
                result = GoogleCredentialImportResult.VerificationFailed(
                    "invalid token=1//do-not-render",
                ),
            ),
        )

        assertEquals("Google could not verify those credentials.", failed.errorMessage)
        assertFalse(failed.toString().contains("1//do-not-render"))
        assertFalse(failed.toString().contains("invalid token"))
    }

    @Test
    fun `local sign out succeeds despite remote revoke failure`() {
        val signingOut = GoogleAccountUiReducer.reduce(
            GoogleAccountUiReducer.reduce(
                GoogleAccountUiReducer.initial(GoogleAccountPresentation.SignedIn(null)),
                GoogleAccountUiEvent.SignOutRequested,
            ),
            GoogleAccountUiEvent.SignOutConfirmed,
        )

        val completed = GoogleAccountUiReducer.reduce(
            signingOut,
            GoogleAccountUiEvent.SignOutCompleted(
                generation = 1,
                result = GoogleSignOutResult.SignedOut(GoogleRemoteRevokeResult.NetworkFailure),
            ),
        )

        assertEquals(GoogleAccountPresentation.SignedOut, completed.account)
        assertEquals(GoogleAccountUiOperation.Idle, completed.operation)
        assertNull(completed.errorMessage)
    }

    @Test
    fun `sign out failure preserves the account and uses fixed copy`() {
        val signingOut = GoogleAccountUiReducer.reduce(
            GoogleAccountUiReducer.reduce(
                GoogleAccountUiReducer.initial(
                    GoogleAccountPresentation.SignedIn("person@example.com"),
                ),
                GoogleAccountUiEvent.SignOutRequested,
            ),
            GoogleAccountUiEvent.SignOutConfirmed,
        )

        val completed = GoogleAccountUiReducer.reduce(
            signingOut,
            GoogleAccountUiEvent.SignOutCompleted(
                generation = 1,
                result = GoogleSignOutResult.LocalClearFailed,
            ),
        )

        assertEquals(
            GoogleAccountPresentation.SignedIn("person@example.com"),
            completed.account,
        )
        assertEquals("Sign-out failed. Please try again.", completed.errorMessage)
    }
}
