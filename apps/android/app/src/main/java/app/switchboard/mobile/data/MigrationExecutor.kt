package app.switchboard.mobile.data

data class MigrationCheckpoint(
    val sourceFingerprint: String,
    val nativeFingerprint: String,
    val state: State,
) {
    enum class State { COMPLETE }

    companion object {
        fun complete(plan: AtomicMigrationPlan) = MigrationCheckpoint(
            sourceFingerprint = plan.sourceFingerprint,
            nativeFingerprint = plan.nativeFingerprint,
            state = State.COMPLETE,
        )
    }
}

interface NativeMigrationStore {
    fun checkpoint(): MigrationCheckpoint?

    /** Implementations must commit or roll back every call as one database transaction. */
    fun <T> transaction(block: (NativeMigrationTransaction) -> T): T
}

interface NativeMigrationTransaction {
    /** Every write is an idempotent upsert. The compatibility source is not exposed here. */
    fun upsert(write: NativeMigrationWrite.Upsert)

    /** Fingerprint the records read back from the transaction before marking completion. */
    fun contentFingerprint(): String

    fun markComplete(checkpoint: MigrationCheckpoint)
}

enum class MigrationExecution { MIGRATED, ALREADY_COMPLETE }

class MigrationVerificationException(expected: String, actual: String) : IllegalStateException(
    "native migration verification failed: expected $expected, got $actual",
)

class MigrationCheckpointConflictException : IllegalStateException(
    "native migration checkpoint belongs to different legacy data",
)

object MigrationExecutor {
    fun execute(plan: AtomicMigrationPlan, store: NativeMigrationStore): MigrationExecution {
        val existing = store.checkpoint()
        if (existing != null) {
            if (existing == MigrationCheckpoint.complete(plan)) return MigrationExecution.ALREADY_COMPLETE
            throw MigrationCheckpointConflictException()
        }

        store.transaction { transaction ->
            for (write in plan.writes) transaction.upsert(write)
            val actualFingerprint = transaction.contentFingerprint()
            if (actualFingerprint != plan.nativeFingerprint) {
                throw MigrationVerificationException(plan.nativeFingerprint, actualFingerprint)
            }
            transaction.markComplete(MigrationCheckpoint.complete(plan))
        }
        return MigrationExecution.MIGRATED
    }
}
