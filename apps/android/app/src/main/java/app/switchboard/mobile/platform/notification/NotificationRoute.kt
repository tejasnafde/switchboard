package app.switchboard.mobile.platform.notification

data class NotificationThreadRoute(
    val connectionId: String,
    val threadId: String,
    val titleHint: String? = null,
    val projectPathHint: String? = null,
    val connectionLabelHint: String? = null,
)

object NotificationRouteCodec {
    const val CONNECTION_ID_KEY = "clientRef"
    const val THREAD_ID_KEY = "threadId"
    const val TITLE_KEY = "title"
    const val PROJECT_PATH_KEY = "projectPath"
    const val CONNECTION_LABEL_KEY = "connectionLabel"

    fun parse(payload: Map<String, *>): NotificationThreadRoute? {
        val connectionId = payload.authoritativeId(CONNECTION_ID_KEY) ?: return null
        val threadId = payload.authoritativeId(THREAD_ID_KEY) ?: return null
        return NotificationThreadRoute(
            connectionId = connectionId,
            threadId = threadId,
            titleHint = payload.optionalHint(TITLE_KEY),
            projectPathHint = payload.optionalHint(PROJECT_PATH_KEY),
            connectionLabelHint = payload.optionalHint(CONNECTION_LABEL_KEY),
        )
    }

    fun encode(route: NotificationThreadRoute): Map<String, String> {
        val normalized = normalize(route) ?: return emptyMap()
        return buildMap {
            put(CONNECTION_ID_KEY, normalized.connectionId)
            put(THREAD_ID_KEY, normalized.threadId)
            normalized.titleHint?.let { put(TITLE_KEY, it) }
            normalized.projectPathHint?.let { put(PROJECT_PATH_KEY, it) }
            normalized.connectionLabelHint?.let { put(CONNECTION_LABEL_KEY, it) }
        }
    }

    fun normalize(route: NotificationThreadRoute): NotificationThreadRoute? = parse(
        mapOf(
            CONNECTION_ID_KEY to route.connectionId,
            THREAD_ID_KEY to route.threadId,
            TITLE_KEY to route.titleHint,
            PROJECT_PATH_KEY to route.projectPathHint,
            CONNECTION_LABEL_KEY to route.connectionLabelHint,
        ),
    )

    private fun Map<String, *>.string(key: String): String? = get(key) as? String

    private fun Map<String, *>.authoritativeId(key: String): String? =
        string(key)?.takeIf { it.isNotBlank() && it.length <= MAX_ID_LENGTH }

    private fun Map<String, *>.optionalHint(key: String): String? {
        val value = string(key)?.takeIf(String::isNotEmpty) ?: return null
        val limit = if (key == PROJECT_PATH_KEY) MAX_PROJECT_PATH_LENGTH else MAX_LABEL_LENGTH
        return value.take(limit)
    }

    private const val MAX_ID_LENGTH = 512
    private const val MAX_LABEL_LENGTH = 200
    private const val MAX_PROJECT_PATH_LENGTH = 4_096
}
