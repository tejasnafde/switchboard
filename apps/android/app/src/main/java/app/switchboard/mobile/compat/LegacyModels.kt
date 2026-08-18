package app.switchboard.mobile.compat

data class LegacyStorageLayout(val database: String, val table: String)

data class LegacyStorageDump(
    val layout: LegacyStorageLayout,
    val rows: LinkedHashMap<String, String>,
)

sealed interface LegacyConnection {
    val id: String
    val label: String
    val inlineToken: String?
    val inlineSession: String?
    val inlinePairing: String?

    data class Ws(
        override val id: String,
        override val label: String,
        val url: String,
        override val inlineToken: String? = null,
        override val inlineSession: String? = null,
        override val inlinePairing: String? = null,
    ) : LegacyConnection

    data class Iap(
        override val id: String,
        override val label: String,
        val project: String,
        val zone: String,
        val instance: String,
        val port: Int,
        override val inlineToken: String? = null,
        override val inlineSession: String? = null,
        override val inlinePairing: String? = null,
    ) : LegacyConnection
}

sealed interface LegacyPreference<out T> {
    val value: T

    data class Persisted<T>(override val value: T) : LegacyPreference<T>
    data class TransientFallback<T>(override val value: T) : LegacyPreference<T>
}

data class LegacyThreadPreference(
    val mode: String?,
    val model: String?,
    val draft: String?,
    val touchedAt: Long,
)

data class LegacyPreferences(
    val threads: LinkedHashMap<String, LegacyThreadPreference>,
    val defaultMode: LegacyPreference<String>,
    val collapsedWorkspaces: List<String>,
) {
    val persistedDefaultMode: String?
        get() = (defaultMode as? LegacyPreference.Persisted)?.value
}

data class LegacyFeedItem(
    val kind: String,
    val id: String,
    val text: String?,
    val images: List<String>,
    val rawJson: String,
)

data class LegacyCachedThread(
    val items: List<LegacyFeedItem>,
    val provider: String?,
    val instanceId: String?,
    val instanceName: String?,
    val status: String?,
    val runtimeMode: String?,
    val sessionId: String?,
    val usedTokens: Long?,
    val maxTokens: Long?,
    val costUsd: Double?,
    val lastTurnDurationMs: Long?,
    val unread: Int,
    val updatedAt: Long?,
    val cached: Boolean,
    val rawJson: String,
)

data class LegacyOutboxImage(val url: String, val mimeType: String?)

data class LegacyOutboxMessage(
    val connectionId: String,
    val threadId: String,
    val messageId: String,
    val text: String,
    val images: List<LegacyOutboxImage>,
    val runtimeMode: String?,
    val createdAt: Long,
    val attempts: Int,
    val sourceKey: String,
    val rawJson: String,
)

enum class LegacyIssueSeverity { BLOCKING, QUARANTINED }

data class LegacyDecodeIssue(
    val sourceKey: String,
    val code: String,
    val detail: String,
    val severity: LegacyIssueSeverity,
    val recordId: String? = null,
)

data class LegacyDecodeReport(
    val sourceRows: LinkedHashMap<String, String>,
    val connections: List<LegacyConnection>,
    val preferences: LegacyPreferences,
    val cachedThreads: LinkedHashMap<String, LegacyCachedThread>,
    val outbox: List<LegacyOutboxMessage>,
    val issues: List<LegacyDecodeIssue>,
) {
    val blockingIssues: List<LegacyDecodeIssue>
        get() = issues.filter { it.severity == LegacyIssueSeverity.BLOCKING }
    val quarantinedIssues: List<LegacyDecodeIssue>
        get() = issues.filter { it.severity == LegacyIssueSeverity.QUARANTINED }
    val canMigrate: Boolean
        get() = blockingIssues.isEmpty()
}
