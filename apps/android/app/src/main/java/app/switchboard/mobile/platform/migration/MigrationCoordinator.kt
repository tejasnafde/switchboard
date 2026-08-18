package app.switchboard.mobile.platform.migration

import app.switchboard.mobile.compat.LegacyConnection
import app.switchboard.mobile.compat.LegacyDecodeIssue
import app.switchboard.mobile.compat.LegacySecureStoreKeys
import app.switchboard.mobile.compat.LegacyStateDecoder
import app.switchboard.mobile.data.MigrationCheckpoint
import app.switchboard.mobile.data.MigrationDecision
import app.switchboard.mobile.data.MigrationExecution
import app.switchboard.mobile.data.MigrationExecutor
import app.switchboard.mobile.data.MigrationPlanner
import app.switchboard.mobile.data.NativeMigrationStore

sealed interface CredentialWriteVerification {
    data object Verified : CredentialWriteVerification
    data class Failed(val detail: String) : CredentialWriteVerification
}

fun interface NativeCredentialStore {
    /** Writes the credential and reads it back before returning [CredentialWriteVerification.Verified]. */
    fun writeAndVerify(
        connectionId: String,
        credential: SelectedCredential.Present,
    ): CredentialWriteVerification
}

fun interface DialGate {
    fun release()
}

data class LegacyCredentialRetirement(
    val connectionId: String,
    val logicalKey: String,
)

sealed interface MigrationBlocker {
    data class Inventory(val failure: LegacyInventoryFailure) : MigrationBlocker
    data class Decode(val issue: LegacyDecodeIssue) : MigrationBlocker
    data class Checkpoint(val detail: String) : MigrationBlocker
    data class CredentialRead(
        val connectionId: String,
        val logicalKey: String,
        val failure: LegacySecureValue.Failure,
    ) : MigrationBlocker
    data class CredentialWrite(val connectionId: String, val detail: String) : MigrationBlocker
    data class Execution(val detail: String) : MigrationBlocker
    data class DialRelease(val detail: String) : MigrationBlocker
}

sealed interface StartupMigrationState {
    val offlineSafe: Boolean

    data class Ready(
        val retirementCandidates: List<LegacyCredentialRetirement> = emptyList(),
        override val offlineSafe: Boolean = true,
    ) : StartupMigrationState

    data class AlreadyComplete(
        override val offlineSafe: Boolean = true,
    ) : StartupMigrationState

    data class Blocked(
        val reasons: List<MigrationBlocker>,
        override val offlineSafe: Boolean = true,
    ) : StartupMigrationState
}

class MigrationCoordinator(
    private val inventory: LegacyInventorySource,
    private val secrets: LegacySecretReader,
    private val credentials: NativeCredentialStore,
    private val store: NativeMigrationStore,
    private val dialGate: DialGate,
) {
    private var completedState: StartupMigrationState? = null

    @Synchronized
    fun run(): StartupMigrationState {
        completedState?.let { return it }

        val rows = when (val inventoryResult = inventory.read()) {
            is LegacyInventoryResult.Success -> inventoryResult.rows
            is LegacyInventoryResult.Failed -> return StartupMigrationState.Blocked(
                inventoryResult.failures.map(MigrationBlocker::Inventory),
            )
        }

        val report = LegacyStateDecoder.decode(rows)
        val plan = when (val decision = MigrationPlanner.plan(report)) {
            is MigrationDecision.Blocked -> return StartupMigrationState.Blocked(
                decision.issues.map(MigrationBlocker::Decode),
            )
            is MigrationDecision.Ready -> decision.plan
        }

        val checkpoint = try {
            store.checkpoint()
        } catch (error: Exception) {
            return StartupMigrationState.Blocked(
                listOf(MigrationBlocker.Checkpoint(error.safeMessage("could not read migration checkpoint"))),
            )
        }
        if (checkpoint != null) {
            if (checkpoint != MigrationCheckpoint.complete(plan)) {
                return StartupMigrationState.Blocked(
                    listOf(MigrationBlocker.Checkpoint("migration checkpoint belongs to different legacy data")),
                )
            }
            return release(StartupMigrationState.AlreadyComplete())
        }

        val retirements = mutableListOf<LegacyCredentialRetirement>()
        for (connection in report.connections.sortedBy { it.id }) {
            when (val resolved = resolveCredential(connection)) {
                is CredentialResolution.Blocked -> return StartupMigrationState.Blocked(
                    listOf(MigrationBlocker.CredentialRead(connection.id, resolved.logicalKey, resolved.failure)),
                )
                CredentialResolution.Missing -> Unit
                is CredentialResolution.Found -> {
                    val write = try {
                        credentials.writeAndVerify(connection.id, resolved.credential)
                    } catch (error: Exception) {
                        CredentialWriteVerification.Failed(error.safeMessage("native credential write failed"))
                    }
                    if (write is CredentialWriteVerification.Failed) {
                        return StartupMigrationState.Blocked(
                            listOf(MigrationBlocker.CredentialWrite(connection.id, write.detail)),
                        )
                    }
                    resolved.legacyLogicalKey?.let {
                        retirements += LegacyCredentialRetirement(connection.id, it)
                    }
                }
            }
        }

        val execution = try {
            MigrationExecutor.execute(plan, store)
        } catch (error: Exception) {
            return StartupMigrationState.Blocked(
                listOf(MigrationBlocker.Execution(error.safeMessage("native migration failed"))),
            )
        }
        return when (execution) {
            MigrationExecution.MIGRATED -> release(StartupMigrationState.Ready(retirements))
            MigrationExecution.ALREADY_COMPLETE -> release(StartupMigrationState.AlreadyComplete())
        }
    }

    private fun resolveCredential(connection: LegacyConnection): CredentialResolution {
        val sessionKey = LegacySecureStoreKeys.sessionKey(connection.id)
        val session = try {
            secrets.read(sessionKey)
        } catch (error: Exception) {
            LegacySecureValue.Failure(
                LegacySecureValue.Failure.Kind.DECRYPTION_FAILED,
                error.safeMessage("could not read legacy session"),
            )
        }
        when (session) {
            is LegacySecureValue.Failure -> return CredentialResolution.Blocked(sessionKey, session)
            is LegacySecureValue.Found -> return CredentialResolution.Found(
                SelectedCredential.DeviceSession(session.value),
                sessionKey,
            )
            LegacySecureValue.Missing -> Unit
        }

        val tokenKey = LegacySecureStoreKeys.tokenKey(connection.id)
        val pairing = try {
            secrets.read(tokenKey)
        } catch (error: Exception) {
            LegacySecureValue.Failure(
                LegacySecureValue.Failure.Kind.DECRYPTION_FAILED,
                error.safeMessage("could not read legacy pairing token"),
            )
        }
        return when (val selected = CredentialPrecedence.select(session, pairing, connection.inlineToken)) {
            is SelectedCredential.Blocked -> CredentialResolution.Blocked(tokenKey, selected.failure)
            is SelectedCredential.Present -> CredentialResolution.Found(
                credential = selected,
                legacyLogicalKey = if (selected is SelectedCredential.PairingToken) tokenKey else null,
            )
            SelectedCredential.Missing -> CredentialResolution.Missing
        }
    }

    private fun <T : StartupMigrationState> release(state: T): StartupMigrationState = try {
        dialGate.release()
        state.also { completedState = it }
    } catch (error: Exception) {
        StartupMigrationState.Blocked(
            listOf(MigrationBlocker.DialRelease(error.safeMessage("could not release dial gate"))),
        )
    }

    private sealed interface CredentialResolution {
        data class Found(
            val credential: SelectedCredential.Present,
            val legacyLogicalKey: String?,
        ) : CredentialResolution
        data object Missing : CredentialResolution
        data class Blocked(
            val logicalKey: String,
            val failure: LegacySecureValue.Failure,
        ) : CredentialResolution
    }
}

private fun Exception.safeMessage(fallback: String): String = message?.takeIf(String::isNotBlank) ?: fallback
