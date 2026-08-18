package app.switchboard.mobile.compat

object LegacyStateDecoder {
    private const val CONNECTIONS_KEY = "sb-connections"
    private const val PREFERENCES_KEY = "switchboard-prefs"
    private const val CHAT_CACHE_KEY = "sb-chat-cache"
    private const val OUTBOX_PREFIX = "sb-outbox:"
    private const val DEFAULT_RUNTIME_MODE = "sandbox"
    private val runtimeModes = setOf("plan", "sandbox", "accept-edits", "full-access")

    fun decode(rows: Map<String, String>): LegacyDecodeReport {
        val sourceRows = LinkedHashMap(rows)
        val issues = mutableListOf<LegacyDecodeIssue>()
        val connections = decodeConnections(rows[CONNECTIONS_KEY], issues)
        val preferences = decodePreferences(rows[PREFERENCES_KEY], issues)
        val cachedThreads = decodeChatCache(rows[CHAT_CACHE_KEY], issues)
        val outbox = rows.entries
            .filter { it.key.startsWith(OUTBOX_PREFIX) }
            .mapNotNull { (key, value) -> decodeOutbox(key, value, issues) }
            .sortedWith(compareBy<LegacyOutboxMessage> { it.createdAt }.thenBy { it.messageId })
        return LegacyDecodeReport(sourceRows, connections, preferences, cachedThreads, outbox, issues)
    }

    private fun decodeConnections(source: String?, issues: MutableList<LegacyDecodeIssue>): List<LegacyConnection> {
        if (source == null) return emptyList()
        val configs = try {
            wrapperState(source).values["configs"]?.arrayOrNull()?.values
                ?: throw LegacyJsonException("state.configs must be an array")
        } catch (error: LegacyJsonException) {
            issues.blocking(CONNECTIONS_KEY, "invalid_json", error.message.orEmpty())
            return emptyList()
        }
        val connections = mutableListOf<LegacyConnection>()
        val seen = mutableSetOf<String>()
        for ((index, encoded) in configs.withIndex()) {
            val objectValue = encoded.objectOrNull()
            val recordId = objectValue?.values?.get("id")?.stringOrNull()
            try {
                val config = objectValue ?: throw LegacyJsonException("connection $index must be an object")
                val id = config.requiredString("id")
                if (!seen.add(id)) throw LegacyJsonException("duplicate connection id")
                val label = config.requiredString("label")
                val token = config.optionalString("token")
                val session = config.optionalString("session")
                val pairing = config.optionalString("pairing")
                val connection = when (config.requiredString("kind")) {
                    "ws" -> LegacyConnection.Ws(
                        id = id,
                        label = label,
                        url = config.requiredString("url"),
                        inlineToken = token,
                        inlineSession = session,
                        inlinePairing = pairing,
                    )
                    "iap" -> {
                        val port = config.values["port"]?.intOrNull()?.takeIf { it in 1..65535 }
                            ?: throw LegacyJsonException("port must be between 1 and 65535")
                        LegacyConnection.Iap(
                            id = id,
                            label = label,
                            project = config.requiredString("project"),
                            zone = config.requiredString("zone"),
                            instance = config.requiredString("instance"),
                            port = port,
                            inlineToken = token,
                            inlineSession = session,
                            inlinePairing = pairing,
                        )
                    }
                    else -> throw LegacyJsonException("unsupported connection kind")
                }
                connections += connection
            } catch (error: LegacyJsonException) {
                issues.blocking(
                    sourceKey = CONNECTIONS_KEY,
                    code = "partial_connection",
                    detail = error.message.orEmpty(),
                    recordId = recordId ?: "index:$index",
                )
            }
        }
        return connections
    }

    private fun decodePreferences(source: String?, issues: MutableList<LegacyDecodeIssue>): LegacyPreferences {
        if (source == null) return emptyPreferences()
        val state = try {
            wrapperState(source)
        } catch (error: LegacyJsonException) {
            issues.quarantined(PREFERENCES_KEY, "invalid_json", error.message.orEmpty())
            return emptyPreferences()
        }

        val defaultMode = when (val encoded = state.values["defaultMode"]) {
            null -> LegacyPreference.TransientFallback(DEFAULT_RUNTIME_MODE)
            else -> {
                val value = encoded.stringOrNull()
                if (value in runtimeModes) {
                    LegacyPreference.Persisted(value!!)
                } else {
                    issues.quarantined(PREFERENCES_KEY, "invalid_default_mode", "defaultMode is unsupported")
                    LegacyPreference.TransientFallback(DEFAULT_RUNTIME_MODE)
                }
            }
        }

        val threads = linkedMapOf<String, LegacyThreadPreference>()
        val encodedThreads = state.values["threads"]?.objectOrNull()?.values.orEmpty()
        for ((key, encoded) in encodedThreads) {
            try {
                val preference = encoded.objectOrNull()
                    ?: throw LegacyJsonException("thread preference must be an object")
                val at = preference.values["at"]?.longOrNull()
                    ?: throw LegacyJsonException("thread preference is missing at")
                val mode = preference.optionalString("mode")
                if (mode != null && mode !in runtimeModes) throw LegacyJsonException("unsupported thread mode")
                threads[key] = LegacyThreadPreference(
                    mode = mode,
                    model = preference.optionalString("model"),
                    draft = preference.optionalString("draft"),
                    touchedAt = at,
                )
            } catch (error: LegacyJsonException) {
                issues.quarantined(PREFERENCES_KEY, "partial_thread_preference", error.message.orEmpty(), key)
            }
        }
        val collapsed = state.values["collapsedWorkspaces"]?.arrayOrNull()?.values.orEmpty()
            .mapNotNull { it.stringOrNull() }
            .distinct()
        return LegacyPreferences(threads, defaultMode, collapsed)
    }

    private fun decodeChatCache(
        source: String?,
        issues: MutableList<LegacyDecodeIssue>,
    ): LinkedHashMap<String, LegacyCachedThread> {
        val result = linkedMapOf<String, LegacyCachedThread>()
        if (source == null) return result
        val threads = try {
            wrapperState(source).values["threads"]?.objectOrNull()?.values
                ?: throw LegacyJsonException("state.threads must be an object")
        } catch (error: LegacyJsonException) {
            issues.quarantined(CHAT_CACHE_KEY, "invalid_shape", error.message.orEmpty())
            return result
        }
        for ((key, encoded) in threads) {
            try {
                val thread = encoded.objectOrNull() ?: throw LegacyJsonException("cached thread must be an object")
                val items = thread.values["items"]?.arrayOrNull()?.values
                    ?: throw LegacyJsonException("cached thread items must be an array")
                val decodedItems = items.mapIndexed { index, item -> decodeFeedItem(item, index) }
                val unread = thread.values["unread"]?.intOrNull() ?: 0
                if (unread < 0) throw LegacyJsonException("unread must not be negative")
                result[key] = LegacyCachedThread(
                    items = decodedItems,
                    provider = thread.optionalString("provider"),
                    instanceId = thread.optionalString("instanceId"),
                    instanceName = thread.optionalString("instanceName"),
                    status = thread.optionalString("status"),
                    runtimeMode = thread.optionalString("runtimeMode"),
                    sessionId = thread.optionalString("sessionId"),
                    usedTokens = thread.values["usedTokens"]?.longOrNull(),
                    maxTokens = thread.values["maxTokens"]?.let { if (it == LegacyJson.NullValue) null else it.longOrNull() },
                    costUsd = thread.values["costUsd"]?.doubleOrNull(),
                    lastTurnDurationMs = thread.values["lastTurnDurationMs"]?.longOrNull(),
                    unread = unread,
                    updatedAt = thread.values["updatedAt"]?.longOrNull(),
                    cached = thread.values["cached"]?.booleanOrNull() ?: false,
                    rawJson = encoded.render(),
                )
            } catch (error: LegacyJsonException) {
                issues.quarantined(CHAT_CACHE_KEY, "partial_cached_thread", error.message.orEmpty(), key)
            }
        }
        return result
    }

    private fun decodeFeedItem(encoded: LegacyJson, index: Int): LegacyFeedItem {
        val item = encoded.objectOrNull() ?: throw LegacyJsonException("feed item $index must be an object")
        val images = item.values["images"]?.arrayOrNull()?.values.orEmpty().mapIndexed { imageIndex, image ->
            image.stringOrNull() ?: throw LegacyJsonException("feed image $imageIndex must be a string")
        }
        return LegacyFeedItem(
            kind = item.requiredString("kind"),
            id = item.requiredString("id"),
            text = item.optionalString("text"),
            images = images,
            rawJson = encoded.render(),
        )
    }

    private fun decodeOutbox(
        sourceKey: String,
        source: String,
        issues: MutableList<LegacyDecodeIssue>,
    ): LegacyOutboxMessage? {
        val objectValue = try {
            LegacyJsonParser.parse(source).objectOrNull()
                ?: throw LegacyJsonException("outbox record must be an object")
        } catch (error: LegacyJsonException) {
            issues.blocking(sourceKey, "invalid_json", error.message.orEmpty())
            return null
        }
        return try {
            val messageId = objectValue.requiredString("messageId")
            if (sourceKey.removePrefix(OUTBOX_PREFIX) != messageId) {
                issues.blocking(sourceKey, "outbox_id_mismatch", "source key and messageId differ", messageId)
                return null
            }
            val images = objectValue.values["images"]?.arrayOrNull()?.values.orEmpty().mapIndexed { index, encoded ->
                val image = encoded.objectOrNull() ?: throw LegacyJsonException("outbox image $index must be an object")
                LegacyOutboxImage(image.requiredString("url"), image.optionalString("mimeType"))
            }
            LegacyOutboxMessage(
                connectionId = objectValue.requiredString("connectionId"),
                threadId = objectValue.requiredString("threadId"),
                messageId = messageId,
                text = objectValue.values["text"]?.stringOrNull()
                    ?: throw LegacyJsonException("outbox text must be a string"),
                images = images,
                runtimeMode = objectValue.optionalString("runtimeMode"),
                createdAt = objectValue.values["createdAt"]?.longOrNull()
                    ?: throw LegacyJsonException("outbox createdAt must be an integer"),
                attempts = objectValue.values["attempts"]?.intOrNull() ?: 0,
                sourceKey = sourceKey,
                rawJson = source,
            )
        } catch (error: LegacyJsonException) {
            issues.blocking(sourceKey, "partial_outbox", error.message.orEmpty())
            null
        }
    }

    private fun wrapperState(source: String): LegacyJson.Object {
        val root = LegacyJsonParser.parse(source).objectOrNull()
            ?: throw LegacyJsonException("persisted value must be an object")
        return root.values["state"]?.objectOrNull()
            ?: throw LegacyJsonException("persisted value is missing state")
    }

    private fun emptyPreferences() = LegacyPreferences(
        threads = linkedMapOf(),
        defaultMode = LegacyPreference.TransientFallback(DEFAULT_RUNTIME_MODE),
        collapsedWorkspaces = emptyList(),
    )
}

private fun MutableList<LegacyDecodeIssue>.blocking(
    sourceKey: String,
    code: String,
    detail: String,
    recordId: String? = null,
) {
    this += LegacyDecodeIssue(sourceKey, code, detail, LegacyIssueSeverity.BLOCKING, recordId)
}

private fun MutableList<LegacyDecodeIssue>.quarantined(
    sourceKey: String,
    code: String,
    detail: String,
    recordId: String? = null,
) {
    this += LegacyDecodeIssue(sourceKey, code, detail, LegacyIssueSeverity.QUARANTINED, recordId)
}
