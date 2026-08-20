package app.switchboard.mobile.ui.search

import app.switchboard.mobile.domain.remote.MessageSearchResult

data class MessageSearchRow(
    val title: String,
    val snippet: String,
    val metadata: String,
    val result: MessageSearchResult,
)

object MessageSearchPresenter {
    fun row(result: MessageSearchResult): MessageSearchRow = MessageSearchRow(
        title = result.conversationTitle,
        snippet = cleanSnippet(result.snippet),
        metadata = "${projectName(result.projectPath)} · ${roleLabel(result.role)}",
        result = result,
    )

    fun cleanSnippet(value: String): String {
        val normalized = value
            .replace("**", "")
            .replace(Regex("\\s+"), " ")
            .trim()
            .trim('.')
            .trim()
        return if (normalized.length <= 240) normalized else normalized.take(240).trimEnd() + "…"
    }

    private fun projectName(path: String): String =
        path.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
            .ifBlank { path }

    private fun roleLabel(role: String): String = when (role.lowercase()) {
        "user" -> "You"
        "assistant" -> "Assistant"
        else -> role.replaceFirstChar { it.uppercase() }
    }
}
