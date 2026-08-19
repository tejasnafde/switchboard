package app.switchboard.mobile.ui.google

import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleCredentialImportResult
import app.switchboard.mobile.platform.google.GoogleSignOutResult

sealed interface GoogleAccountUiOperation {
    data object Idle : GoogleAccountUiOperation
    data class Importing(val generation: Long) : GoogleAccountUiOperation
    data class SigningOut(val generation: Long) : GoogleAccountUiOperation
}

data class GoogleAccountUiState(
    val account: GoogleAccountPresentation,
    val detailsExpanded: Boolean = false,
    val signOutConfirmationVisible: Boolean = false,
    val operation: GoogleAccountUiOperation = GoogleAccountUiOperation.Idle,
    val errorMessage: String? = null,
    internal val generation: Long = 0,
)

sealed interface GoogleAccountUiEvent {
    data object DetailsToggled : GoogleAccountUiEvent
    data object SignOutRequested : GoogleAccountUiEvent
    data object SignOutDismissed : GoogleAccountUiEvent
    data object SignOutConfirmed : GoogleAccountUiEvent
    data object ImportStarted : GoogleAccountUiEvent
    data class AccountChanged(val account: GoogleAccountPresentation) : GoogleAccountUiEvent
    data class ImportCompleted(
        val generation: Long,
        val result: GoogleCredentialImportResult,
    ) : GoogleAccountUiEvent
    data class SignOutCompleted(
        val generation: Long,
        val result: GoogleSignOutResult,
    ) : GoogleAccountUiEvent
    data class ImportFailed(val generation: Long) : GoogleAccountUiEvent
    data class SignOutFailed(val generation: Long) : GoogleAccountUiEvent
}

object GoogleAccountUiReducer {
    fun initial(account: GoogleAccountPresentation): GoogleAccountUiState =
        GoogleAccountUiState(account = account)

    fun reduce(
        state: GoogleAccountUiState,
        event: GoogleAccountUiEvent,
    ): GoogleAccountUiState = when (event) {
        GoogleAccountUiEvent.DetailsToggled -> state.copy(
            detailsExpanded = !state.detailsExpanded,
        )

        GoogleAccountUiEvent.SignOutRequested -> if (
            state.account is GoogleAccountPresentation.SignedIn &&
            state.operation == GoogleAccountUiOperation.Idle
        ) {
            state.copy(signOutConfirmationVisible = true, errorMessage = null)
        } else {
            state
        }

        GoogleAccountUiEvent.SignOutDismissed -> state.copy(
            signOutConfirmationVisible = false,
        )

        GoogleAccountUiEvent.SignOutConfirmed -> if (
            state.signOutConfirmationVisible &&
            state.account is GoogleAccountPresentation.SignedIn &&
            state.operation == GoogleAccountUiOperation.Idle
        ) {
            val generation = state.generation + 1
            state.copy(
                signOutConfirmationVisible = false,
                operation = GoogleAccountUiOperation.SigningOut(generation),
                errorMessage = null,
                generation = generation,
            )
        } else {
            state
        }

        GoogleAccountUiEvent.ImportStarted -> if (
            GoogleAccountUiPresenter.showsCredentialImport(state.account) &&
            state.operation == GoogleAccountUiOperation.Idle
        ) {
            val generation = state.generation + 1
            state.copy(
                operation = GoogleAccountUiOperation.Importing(generation),
                errorMessage = null,
                generation = generation,
            )
        } else {
            state
        }

        is GoogleAccountUiEvent.AccountChanged -> {
            if (state.account == event.account && state.operation == GoogleAccountUiOperation.Idle) {
                state
            } else {
                state.copy(
                    account = event.account,
                    signOutConfirmationVisible = false,
                    operation = GoogleAccountUiOperation.Idle,
                    errorMessage = null,
                    generation = state.generation + 1,
                )
            }
        }

        is GoogleAccountUiEvent.ImportCompleted -> reduceImportCompletion(state, event)
        is GoogleAccountUiEvent.SignOutCompleted -> reduceSignOutCompletion(state, event)
        is GoogleAccountUiEvent.ImportFailed -> if (state.acceptsImport(event.generation)) {
            state.copy(
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = IMPORT_FAILED,
            )
        } else {
            state
        }

        is GoogleAccountUiEvent.SignOutFailed -> if (state.acceptsSignOut(event.generation)) {
            state.copy(
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = SIGN_OUT_FAILED,
            )
        } else {
            state
        }
    }

    private fun reduceImportCompletion(
        state: GoogleAccountUiState,
        event: GoogleAccountUiEvent.ImportCompleted,
    ): GoogleAccountUiState {
        if (!state.acceptsImport(event.generation)) return state
        return when (val result = event.result) {
            is GoogleCredentialImportResult.Success -> state.copy(
                account = GoogleAccountPresentation.SignedIn(result.email),
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = null,
            )

            GoogleCredentialImportResult.InvalidInput -> state.importFailure(INVALID_CREDENTIALS)
            is GoogleCredentialImportResult.VerificationFailed ->
                state.importFailure(VERIFICATION_FAILED)
            GoogleCredentialImportResult.PersistenceFailed ->
                state.importFailure(PERSISTENCE_FAILED)
            GoogleCredentialImportResult.Superseded ->
                state.importFailure(IMPORT_SUPERSEDED)
            GoogleCredentialImportResult.Cancelled -> state.copy(
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = null,
            )
        }
    }

    private fun reduceSignOutCompletion(
        state: GoogleAccountUiState,
        event: GoogleAccountUiEvent.SignOutCompleted,
    ): GoogleAccountUiState {
        if (!state.acceptsSignOut(event.generation)) return state
        return when (event.result) {
            is GoogleSignOutResult.SignedOut,
            GoogleSignOutResult.AlreadySignedOut,
            -> state.copy(
                account = GoogleAccountPresentation.SignedOut,
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = null,
            )

            GoogleSignOutResult.Blocked -> state.copy(
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = BLOCKED_CREDENTIALS,
            )

            GoogleSignOutResult.Superseded -> state.copy(
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = SIGN_OUT_SUPERSEDED,
            )

            GoogleSignOutResult.LocalClearFailed -> state.copy(
                operation = GoogleAccountUiOperation.Idle,
                errorMessage = SIGN_OUT_FAILED,
            )
        }
    }

    private fun GoogleAccountUiState.importFailure(message: String): GoogleAccountUiState = copy(
        operation = GoogleAccountUiOperation.Idle,
        errorMessage = message,
    )

    internal fun GoogleAccountUiState.acceptsImport(generation: Long): Boolean =
        operation == GoogleAccountUiOperation.Importing(generation)

    private fun GoogleAccountUiState.acceptsSignOut(generation: Long): Boolean =
        operation == GoogleAccountUiOperation.SigningOut(generation)

    const val INVALID_CREDENTIALS =
        "That does not look like the code the desktop app showed you."
    const val VERIFICATION_FAILED = "Google could not verify those credentials."
    const val PERSISTENCE_FAILED = "Credentials could not be saved securely on this device."
    const val IMPORT_SUPERSEDED = "A newer credential import replaced this attempt."
    const val IMPORT_FAILED = "Import failed. Please try again."
    const val SIGN_OUT_SUPERSEDED = "The Google account changed before sign-out finished."
    const val SIGN_OUT_FAILED = "Sign-out failed. Please try again."
    const val BLOCKED_CREDENTIALS =
        "Saved Google account credentials cannot be read on this device."
}

object GoogleAccountUiPresenter {
    fun accountValue(account: GoogleAccountPresentation): String = when (account) {
        GoogleAccountPresentation.SignedOut -> GoogleAccountPresentation.SignedOut.Message
        is GoogleAccountPresentation.SignedIn ->
            account.email?.trim()?.takeIf(String::isNotEmpty) ?: "Google account connected"
        GoogleAccountPresentation.Blocked -> GoogleAccountPresentation.Blocked.Message
    }

    fun showsCredentialImport(account: GoogleAccountPresentation): Boolean =
        account !is GoogleAccountPresentation.SignedIn

    fun visibleError(account: GoogleAccountPresentation, operationError: String?): String? =
        operationError ?: if (account == GoogleAccountPresentation.Blocked) {
            GoogleAccountPresentation.Blocked.Message
        } else {
            null
        }

    fun monogram(account: GoogleAccountPresentation): String = when (account) {
        is GoogleAccountPresentation.SignedIn -> account.email
            ?.substringBefore('@')
            ?.split('.', '_', '-', ' ')
            ?.filter(String::isNotBlank)
            ?.let { parts ->
                when {
                    parts.size > 1 -> "${parts.first().first()}${parts.last().first()}"
                    parts.isNotEmpty() -> parts.first().take(2)
                    else -> null
                }
            }
            ?.uppercase()
            ?: "G"
        GoogleAccountPresentation.SignedOut -> "G"
        GoogleAccountPresentation.Blocked -> "!"
    }

    fun identity(account: GoogleAccountPresentation): String = accountValue(account)

    fun statusTitle(account: GoogleAccountPresentation): String = when (account) {
        is GoogleAccountPresentation.SignedIn -> "Ready for Google IAP"
        GoogleAccountPresentation.SignedOut -> "Google account required"
        GoogleAccountPresentation.Blocked -> "Credentials need attention"
    }

    fun statusSupportingText(account: GoogleAccountPresentation): String = when (account) {
        is GoogleAccountPresentation.SignedIn ->
            "Credentials are encrypted on this device and used only when connecting."
        GoogleAccountPresentation.SignedOut ->
            "Connect an account to reach work VMs through Google Cloud IAP."
        GoogleAccountPresentation.Blocked ->
            "Import the credentials from Switchboard on your Mac again."
    }
}

object GoogleAccountAccessibilityPolicy {
    fun detailsState(expanded: Boolean): String = if (expanded) "Expanded" else "Collapsed"

    fun accountState(account: GoogleAccountPresentation): String = when (account) {
        GoogleAccountPresentation.SignedOut -> "Signed out"
        is GoogleAccountPresentation.SignedIn -> "Signed in"
        GoogleAccountPresentation.Blocked -> "Blocked"
    }

    fun importState(
        hasCredentialDraft: Boolean,
        operation: GoogleAccountUiOperation,
    ): String = when (operation) {
        is GoogleAccountUiOperation.Importing -> "Importing credentials"
        is GoogleAccountUiOperation.SigningOut -> "Unavailable while signing out"
        GoogleAccountUiOperation.Idle -> if (hasCredentialDraft) {
            "Ready to import"
        } else {
            "Paste credentials to enable import"
        }
    }

    fun signOutState(operation: GoogleAccountUiOperation): String = when (operation) {
        is GoogleAccountUiOperation.SigningOut -> "Signing out"
        is GoogleAccountUiOperation.Importing -> "Unavailable while importing credentials"
        GoogleAccountUiOperation.Idle -> "Ready"
    }
}
