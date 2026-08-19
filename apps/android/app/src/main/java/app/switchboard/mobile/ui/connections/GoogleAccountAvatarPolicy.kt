package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.platform.google.GoogleAccountPresentation

object GoogleAccountAvatarPolicy {
    fun monogramOrNull(presentation: GoogleAccountPresentation): String? {
        val email = (presentation as? GoogleAccountPresentation.SignedIn)?.email ?: return null
        val local = email.orEmpty().substringBefore('@')
        val words = local.split(Separator).filter { word -> word.any(Char::isLetterOrDigit) }
        return when (words.size) {
            0 -> null
            1 -> words.single().take(2).uppercase()
            else -> "${words[0].first()}${words[1].first()}".uppercase()
        }
    }

    private val Separator = Regex("[._+\\-]+")
}
