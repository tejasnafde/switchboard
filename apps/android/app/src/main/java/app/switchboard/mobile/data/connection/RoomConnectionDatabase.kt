package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.data.local.NativeCredentialRefEntity
import app.switchboard.mobile.data.local.SwitchboardDatabase

class RoomConnectionDatabase(
    private val database: SwitchboardDatabase,
) : ConnectionDatabase {
    override fun find(connectionId: String): StoredConnection? =
        database.connectionDao().find(connectionId)?.let { connection ->
            StoredConnection(
                connection = connection,
                activeCredentialKey = database.connectionDao()
                    .findNativeCredentialRef(connectionId)
                    ?.logicalKey,
            )
        }

    override fun upsert(connection: ConnectionEntity, activeCredentialKey: String) {
        database.connectionDao().upsertWithNativeCredential(
            connection,
            NativeCredentialRefEntity(connection.id, activeCredentialKey),
        )
    }

    override fun compareAndSwapCredentialRef(
        connectionId: String,
        expectedOldRef: String,
        newRef: String,
    ): OfflineSnapshot? {
        var snapshot: OfflineSnapshot? = null
        database.runInTransaction {
            val changed = database.connectionDao().compareAndSwapNativeCredentialRef(
                connectionId,
                expectedOldRef,
                newRef,
            )
            if (changed == 1) {
                val reread = database.offlineSnapshotDao().read()
                check(
                    reread.nativeCredentialRefs.any {
                        it.connectionId == connectionId && it.logicalKey == newRef
                    },
                ) { "credential rotation read-back failed" }
                snapshot = reread
            }
        }
        return snapshot
    }

    override fun delete(connectionId: String): Boolean =
        database.connectionDao().delete(connectionId) > 0

    override fun snapshot(): OfflineSnapshot = database.offlineSnapshotDao().read()
}
