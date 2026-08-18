package app.switchboard.mobile.platform.google

sealed interface GoogleAccountPresentation {
    data object SignedOut : GoogleAccountPresentation {
        const val Message = "No Google account is connected."
    }

    data class SignedIn(val email: String?) : GoogleAccountPresentation

    data object Blocked : GoogleAccountPresentation {
        const val Message = "Saved Google account credentials cannot be read on this device."
    }
}

object GoogleAccountPresenter {
    fun present(status: GoogleCredentialReadResult): GoogleAccountPresentation = when (status) {
        GoogleCredentialReadResult.Absent -> GoogleAccountPresentation.SignedOut
        is GoogleCredentialReadResult.Available ->
            GoogleAccountPresentation.SignedIn(status.credentials.email)
        is GoogleCredentialReadResult.Blocked -> GoogleAccountPresentation.Blocked
    }
}
