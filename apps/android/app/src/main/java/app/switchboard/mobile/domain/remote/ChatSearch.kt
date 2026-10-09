package app.switchboard.mobile.domain.remote

/**
 * Go to chat's search rules, ported from src/shared/chat-search.ts: archived
 * chats only with the word "archive" or "archived" (which is not matched),
 * then exact title, title starts with, title contains, project name contains,
 * newest first inside each tier. Both run tests/fixtures/chat-search-cases.json.
 */
object ChatSearch {
    data class Item(val title: String, val projectName: String, val lastActivity: Long, val archived: Boolean = false)

    data class Query(val needle: String, val includeArchived: Boolean)

    private val archiveWords = setOf("archive", "archived")
    private val whitespace = Regex("\\s+")

    fun parse(raw: String): Query {
        val words = raw.lowercase().split(whitespace).filter(String::isNotEmpty)
        val kept = words.filterNot(archiveWords::contains)
        return Query(kept.joinToString(" "), kept.size != words.size)
    }

    /** The rows a query shows, best first. An empty query is every row, newest first. */
    fun <T> rank(rows: List<T>, raw: String, item: (T) -> Item): List<T> {
        val query = parse(raw)
        return rows
            .map { row -> row to item(row) }
            .filter { (_, it) -> query.includeArchived || !it.archived }
            .map { (row, it) -> Triple(row, it.lastActivity, tier(it, query.needle)) }
            .filter { it.third >= 0 }
            .sortedWith(compareBy<Triple<T, Long, Int>> { it.third }.thenByDescending { it.second })
            .map { it.first }
    }

    private fun tier(item: Item, needle: String): Int {
        if (needle.isEmpty()) return 0
        val title = item.title.lowercase()
        return when {
            title == needle -> 0
            title.startsWith(needle) -> 1
            title.contains(needle) -> 2
            item.projectName.lowercase().contains(needle) -> 3
            else -> -1
        }
    }
}
