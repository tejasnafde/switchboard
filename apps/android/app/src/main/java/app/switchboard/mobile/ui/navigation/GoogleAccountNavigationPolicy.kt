package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.platform.google.GoogleAccountPresentation

object GoogleAccountNavigationPolicy {
    const val QrUnavailableNotice =
        "QR scanning is not available in this native build yet. Paste the credential code below."

    fun isReady(presentation: GoogleAccountPresentation): Boolean =
        presentation is GoogleAccountPresentation.SignedIn
}
