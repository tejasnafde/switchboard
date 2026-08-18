package app.switchboard.mobile.data

import app.switchboard.mobile.compat.LegacyConnection
import app.switchboard.mobile.compat.LegacyDecodeIssue
import app.switchboard.mobile.compat.LegacyDecodeReport
import app.switchboard.mobile.compat.LegacyPreference
import app.switchboard.mobile.compat.LegacyThreadPreference
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

sealed interface NativeMigrationWrite {
    sealed interface Upsert : NativeMigrationWrite {
        fun fingerprintValue(): String
    }

    data class UpsertConnection(
        val connectionId: String,
        val connection: LegacyConnection,
    ) : Upsert {
        override fun fingerprintValue() = "connection|$connectionId|$connection"
    }

    data class UpsertCredentialReferences(
        val connectionId: String,
        val tokenLogicalKey: String,
        val sessionLogicalKey: String,
    ) : Upsert {
        override fun fingerprintValue() = "credentials|$connectionId|$tokenLogicalKey|$sessionLogicalKey"
    }

    data class UpsertDefaultMode(val mode: String) : Upsert {
        override fun fingerprintValue() = "default-mode|$mode"
    }

    data class UpsertThreadPreference(
        val threadKey: String,
        val preference: LegacyThreadPreference,
    ) : Upsert {
        override fun fingerprintValue() = "thread-preference|$threadKey|$preference"
    }

    data class UpsertCollapsedWorkspaces(val workspaceIds: List<String>) : Upsert {
        override fun fingerprintValue() = "collapsed|${workspaceIds.joinToString("\u0000")}"
    }

    data class UpsertCachedThread(val threadKey: String, val rawJson: String) : Upsert {
        override fun fingerprintValue() = "cache|$threadKey|$rawJson"
    }

    data class UpsertOutbox(val messageId: String, val rawJson: String) : Upsert {
        override fun fingerprintValue() = "outbox|$messageId|$rawJson"
    }

    data class UpsertQuarantine(val issue: LegacyDecodeIssue) : Upsert {
        override fun fingerprintValue() = "quarantine|$issue"
    }
}

data class AtomicMigrationPlan(
    val sourceFingerprint: String,
    val nativeFingerprint: String,
    val writes: List<NativeMigrationWrite.Upsert>,
)

sealed interface MigrationDecision {
    data class Ready(val plan: AtomicMigrationPlan) : MigrationDecision
    data class Blocked(val issues: List<LegacyDecodeIssue>) : MigrationDecision
}

object MigrationPlanner {
    fun plan(report: LegacyDecodeReport): MigrationDecision {
        if (!report.canMigrate) return MigrationDecision.Blocked(report.blockingIssues)

        val writes = buildList {
            for (connection in report.connections.sortedBy { it.id }) {
                add(NativeMigrationWrite.UpsertConnection(connection.id, connection))
                add(
                    NativeMigrationWrite.UpsertCredentialReferences(
                        connectionId = connection.id,
                        tokenLogicalKey = app.switchboard.mobile.compat.LegacySecureStoreKeys.tokenKey(connection.id),
                        sessionLogicalKey = app.switchboard.mobile.compat.LegacySecureStoreKeys.sessionKey(connection.id),
                    ),
                )
            }
            if (report.sourceRows.containsKey("switchboard-prefs")) {
                val persistedMode = report.preferences.defaultMode as? LegacyPreference.Persisted
                if (persistedMode != null) add(NativeMigrationWrite.UpsertDefaultMode(persistedMode.value))
                for ((key, preference) in report.preferences.threads.toSortedMap()) {
                    add(NativeMigrationWrite.UpsertThreadPreference(key, preference))
                }
                add(NativeMigrationWrite.UpsertCollapsedWorkspaces(report.preferences.collapsedWorkspaces))
            }
            for ((key, thread) in report.cachedThreads.toSortedMap()) {
                add(NativeMigrationWrite.UpsertCachedThread(key, thread.rawJson))
            }
            for (message in report.outbox.sortedWith(compareBy({ it.createdAt }, { it.messageId }))) {
                add(NativeMigrationWrite.UpsertOutbox(message.messageId, message.rawJson))
            }
            for (issue in report.quarantinedIssues.sortedWith(compareBy({ it.sourceKey }, { it.recordId }, { it.code }))) {
                add(NativeMigrationWrite.UpsertQuarantine(issue))
            }
        }
        return MigrationDecision.Ready(
            AtomicMigrationPlan(
                sourceFingerprint = fingerprintRows(report.sourceRows),
                nativeFingerprint = fingerprintWrites(writes),
                writes = writes,
            ),
        )
    }

    private fun fingerprintRows(rows: Map<String, String>): String = digest(
        rows.toSortedMap().entries.map { (key, value) -> "${key.length}:$key|${value.length}:$value" },
    )

    private fun fingerprintWrites(writes: List<NativeMigrationWrite.Upsert>): String =
        digest(writes.map { it.fingerprintValue() })

    private fun digest(parts: List<String>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        for (part in parts) {
            val bytes = part.toByteArray(StandardCharsets.UTF_8)
            digest.update((bytes.size.toString() + ":").toByteArray(StandardCharsets.US_ASCII))
            digest.update(bytes)
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
