package app.switchboard.mobile.data.local

import app.switchboard.mobile.compat.LegacyConnection
import app.switchboard.mobile.compat.LegacyJson
import app.switchboard.mobile.compat.LegacyJsonParser
import app.switchboard.mobile.compat.arrayOrNull
import app.switchboard.mobile.compat.intOrNull
import app.switchboard.mobile.compat.longOrNull
import app.switchboard.mobile.compat.objectOrNull
import app.switchboard.mobile.compat.render
import app.switchboard.mobile.compat.stringOrNull
import app.switchboard.mobile.data.NativeMigrationWrite
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

object LocalMigrationMapper {
    fun connection(write: NativeMigrationWrite.UpsertConnection): ConnectionEntity = when (val source = write.connection) {
        is LegacyConnection.Ws -> ConnectionEntity(
            id = write.connectionId,
            label = source.label,
            kind = "ws",
            url = source.url,
            project = null,
            zone = null,
            instance = null,
            port = null,
        )
        is LegacyConnection.Iap -> ConnectionEntity(
            id = write.connectionId,
            label = source.label,
            kind = "iap",
            url = null,
            project = source.project,
            zone = source.zone,
            instance = source.instance,
            port = source.port,
        )
    }

    fun credentialRefs(write: NativeMigrationWrite.UpsertCredentialReferences) = CredentialRefEntity(
        connectionId = write.connectionId,
        tokenLogicalKey = write.tokenLogicalKey,
        sessionLogicalKey = write.sessionLogicalKey,
    )

    fun threadPreference(write: NativeMigrationWrite.UpsertThreadPreference) = ThreadPreferenceEntity(
        threadKey = write.threadKey,
        mode = write.preference.mode,
        model = write.preference.model,
        draft = write.preference.draft,
        touchedAt = write.preference.touchedAt,
    )

    fun cachedThread(write: NativeMigrationWrite.UpsertCachedThread): CachedThreadWithFeed {
        val root = LegacyJsonParser.parse(write.rawJson).objectOrNull()
            ?: error("cached thread must be a JSON object")
        val items = root.values["items"]?.arrayOrNull()?.values
            ?: error("cached thread items must be an array")
        return CachedThreadWithFeed(
            thread = CachedThreadEntity(write.threadKey, write.rawJson),
            feed = items.mapIndexed { position, item ->
                val itemId = item.objectOrNull()?.values?.get("id")?.stringOrNull()
                    ?: error("cached feed item must have an id")
                CachedFeedRowEntity(write.threadKey, itemId, position, item.render())
            },
        )
    }

    fun outbox(write: NativeMigrationWrite.UpsertOutbox): OutboxWithAttachments {
        val root = LegacyJsonParser.parse(write.rawJson).objectOrNull()
            ?: error("outbox message must be a JSON object")
        val encodedId = root.requiredString("messageId")
        require(encodedId == write.messageId) { "outbox message id does not match its key" }
        return OutboxWithAttachments(
            message = OutboxEntity(
                origin = write.messageId,
                bubbleId = "remote_${write.messageId}",
                connectionId = root.requiredString("connectionId"),
                threadId = root.requiredString("threadId"),
                text = root.requiredString("text"),
                runtimeMode = root.values["runtimeMode"]?.stringOrNull(),
                createdAtMs = root.values["createdAt"]?.longOrNull()
                    ?: error("outbox createdAt must be an integer"),
                attempts = root.values["attempts"]?.intOrNull() ?: 0,
                nextAttemptAtMs = root.values["createdAt"]?.longOrNull()
                    ?: error("outbox createdAt must be an integer"),
                deliveryState = "pending",
                stateReason = null,
                receiptLegacy = null,
                receiptDuplicate = null,
                receiptRawJson = null,
                legacyRawJson = write.rawJson,
            ),
            // Legacy image data remains losslessly available in rawJson. Only paths copied into the
            // native app's private directory belong in outbox_attachments.
            attachments = emptyList(),
        )
    }

    fun quarantine(write: NativeMigrationWrite.UpsertQuarantine) = QuarantinedRecordEntity(
        sourceKey = write.issue.sourceKey,
        code = write.issue.code,
        recordKey = write.issue.recordId.orEmpty(),
        detail = write.issue.detail,
        severity = write.issue.severity.name,
    )

    internal fun readbackConnection(
        row: ConnectionEntity,
        sourceCredentials: LegacyConnection,
    ): LegacyConnection = when (row.kind) {
        "ws" -> LegacyConnection.Ws(
            id = row.id,
            label = row.label,
            url = requireNotNull(row.url),
            inlineToken = sourceCredentials.inlineToken,
            inlineSession = sourceCredentials.inlineSession,
            inlinePairing = sourceCredentials.inlinePairing,
        )
        "iap" -> LegacyConnection.Iap(
            id = row.id,
            label = row.label,
            project = requireNotNull(row.project),
            zone = requireNotNull(row.zone),
            instance = requireNotNull(row.instance),
            port = requireNotNull(row.port),
            inlineToken = sourceCredentials.inlineToken,
            inlineSession = sourceCredentials.inlineSession,
            inlinePairing = sourceCredentials.inlinePairing,
        )
        else -> error("unsupported native connection kind ${row.kind}")
    }
}

object LocalMigrationFingerprint {
    fun fingerprint(writes: List<NativeMigrationWrite.Upsert>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        for (write in writes) {
            val bytes = write.fingerprintValue().toByteArray(StandardCharsets.UTF_8)
            digest.update((bytes.size.toString() + ":").toByteArray(StandardCharsets.US_ASCII))
            digest.update(bytes)
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}

private fun LegacyJson.Object.requiredString(key: String): String =
    values[key]?.stringOrNull() ?: error("$key must be a string")
