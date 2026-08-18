package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.connection.ConnectionRuntimeEvent
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.connection.ConnectionStatus
import app.switchboard.mobile.domain.connection.ConnectionStatusReducer
import app.switchboard.mobile.data.remote.RemoteRpc
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.platform.protocol.WebSocketTarget
import java.io.Closeable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

fun interface ConnectionFleetSnapshotSource {
    fun snapshots(): StateFlow<OfflineSnapshot?>
}

fun interface ConnectionFleetTargetResolver {
    fun resolve(connectionId: String): ConnectionTargetResolution
}

fun interface ConnectionFleetRemover {
    suspend fun remove(connectionId: String): ConnectionRemoveResult
}

interface ConnectionFleetCoordinator {
    val endpoint: ConnectionFleetEndpoint?

    fun connect(target: WebSocketTarget)
    fun disconnect()
    fun destroy()
}

data class ConnectionFleetEndpoint(
    val scope: TransportScope,
    val capabilities: Set<String>,
    val rpc: RemoteRpc,
)

fun interface ConnectionFleetCoordinatorFactory {
    fun create(
        connectionId: String,
        generation: Long,
        onEvent: (ConnectionRuntimeEvent) -> Unit,
    ): ConnectionFleetCoordinator
}

class RepositoryConnectionFleetSnapshotSource(
    private val repository: NativeConnectionRepository,
) : ConnectionFleetSnapshotSource {
    override fun snapshots(): StateFlow<OfflineSnapshot?> = repository.snapshots
}

class DeviceConnectionFleetTargetResolver(
    private val resolver: NativeConnectionTargetResolver,
    private val deviceId: String,
    private val deviceLabel: String,
) : ConnectionFleetTargetResolver {
    override fun resolve(connectionId: String): ConnectionTargetResolution =
        resolver.resolve(connectionId, deviceId, deviceLabel)
}

class ConnectionFleet(
    private val scope: CoroutineScope,
    private val snapshots: ConnectionFleetSnapshotSource,
    private val targetResolver: ConnectionFleetTargetResolver,
    private val coordinatorFactory: ConnectionFleetCoordinatorFactory,
    private val remover: ConnectionFleetRemover,
) : Closeable {
    private data class StoredSpec(
        val row: ConnectionEntity,
        val credentialKey: String?,
    ) {
        val eligibleForAutoConnect: Boolean =
            row.kind == WEBSOCKET_KIND && !row.url.isNullOrBlank() && !credentialKey.isNullOrBlank()

        override fun equals(other: Any?): Boolean =
            other is StoredSpec &&
                row.id == other.row.id &&
                row.kind == other.row.kind &&
                row.url == other.row.url &&
                row.project == other.row.project &&
                row.zone == other.row.zone &&
                row.instance == other.row.instance &&
                row.port == other.row.port &&
                credentialKey == other.credentialKey

        override fun hashCode(): Int {
            var result = row.id.hashCode()
            result = 31 * result + row.kind.hashCode()
            result = 31 * result + (row.url?.hashCode() ?: 0)
            result = 31 * result + (row.project?.hashCode() ?: 0)
            result = 31 * result + (row.zone?.hashCode() ?: 0)
            result = 31 * result + (row.instance?.hashCode() ?: 0)
            result = 31 * result + (row.port ?: 0)
            result = 31 * result + (credentialKey?.hashCode() ?: 0)
            return result
        }
    }

    private data class Entry(
        var spec: StoredSpec,
        var generation: Long,
        var desiredConnected: Boolean,
        var coordinator: ConnectionFleetCoordinator? = null,
    )

    private val mutableStatuses = MutableStateFlow<Map<String, ConnectionRuntimeState>>(emptyMap())
    val statuses = mutableStatuses.asStateFlow()

    private val entries = linkedMapOf<String, Entry>()
    private val desiredBeforeDiscovery = mutableMapOf<String, Boolean>()
    private val suppressedBySuccessfulRemove = mutableSetOf<String>()
    private var latestSpecs = emptyMap<String, StoredSpec>()
    private var observation: Job? = null
    private var nextGeneration = 0L
    private var started = false
    private var closed = false

    @Synchronized
    fun startupReady() {
        if (closed || started) return
        started = true
        observation = scope.launch {
            snapshots.snapshots().filterNotNull().collect(::reconcile)
        }
    }

    @Synchronized
    fun connect(connectionId: String) {
        if (closed) return
        suppressedBySuccessfulRemove -= connectionId
        val entry = entries[connectionId] ?: createKnownEntry(connectionId, desiredConnected = true)
        if (entry == null) {
            desiredBeforeDiscovery[connectionId] = true
            return
        }
        entry.desiredConnected = true
        if (entry.coordinator == null) start(entry)
    }

    @Synchronized
    fun disconnect(connectionId: String) {
        if (closed) return
        desiredBeforeDiscovery[connectionId] = false
        val entry = entries[connectionId] ?: return
        entry.desiredConnected = false
        stopAndInvalidate(entry, detail = "")
    }

    @Synchronized
    fun retry(connectionId: String) {
        if (closed) return
        suppressedBySuccessfulRemove -= connectionId
        val entry = entries[connectionId] ?: createKnownEntry(connectionId, desiredConnected = true)
        if (entry == null) {
            desiredBeforeDiscovery[connectionId] = true
            return
        }
        entry.desiredConnected = true
        stop(entry)
        start(entry)
    }

    @Synchronized
    fun endpoint(connectionId: String): ConnectionFleetEndpoint? {
        if (closed) return null
        val entry = entries[connectionId] ?: return null
        val status = mutableStatuses.value[connectionId] ?: return null
        if (
            !entry.desiredConnected ||
            status.generation != entry.generation ||
            status.status != ConnectionStatus.Connected
        ) {
            return null
        }
        val endpoint = entry.coordinator?.endpoint ?: return null
        if (endpoint.rpc.scope != endpoint.scope) return null
        return endpoint
    }

    suspend fun remove(connectionId: String): ConnectionRemoveResult {
        synchronized(this) {
            if (closed) return ConnectionRemoveResult.Failure("Connection fleet is closed")
            desiredBeforeDiscovery[connectionId] = false
            suppressedBySuccessfulRemove += connectionId
            entries[connectionId]?.let { entry ->
                entry.desiredConnected = false
                stopAndInvalidate(entry, detail = "removing")
            }
        }

        val result = try {
            remover.remove(connectionId)
        } catch (exception: Exception) {
            ConnectionRemoveResult.Failure(exception.message ?: "Could not remove the machine")
        }
        synchronized(this) {
            if (closed) return result
            when (result) {
                ConnectionRemoveResult.Success -> {
                    entries.remove(connectionId)?.let(::stop)
                    removeStatus(connectionId)
                }
                is ConnectionRemoveResult.Failure -> {
                    suppressedBySuccessfulRemove -= connectionId
                    val spec = latestSpecs[connectionId]
                    if (spec == null) {
                        entries.remove(connectionId)?.let(::stop)
                        removeStatus(connectionId)
                    } else {
                        val entry = entries[connectionId] ?: Entry(
                            spec = spec,
                            generation = allocateGeneration(),
                            desiredConnected = false,
                        ).also { entries[connectionId] = it }
                        entry.spec = spec
                        entry.desiredConnected = false
                        setStatus(
                            connectionId,
                            ConnectionRuntimeState(entry.generation, ConnectionStatus.Error, result.message),
                        )
                    }
                }
            }
        }
        return result
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        observation?.cancel()
        observation = null
        entries.values.forEach(::stop)
        entries.clear()
        latestSpecs = emptyMap()
        desiredBeforeDiscovery.clear()
        suppressedBySuccessfulRemove.clear()
        mutableStatuses.value = emptyMap()
    }

    @Synchronized
    private fun reconcile(snapshot: OfflineSnapshot) {
        if (closed) return
        val refs = snapshot.nativeCredentialRefs.associate { it.connectionId to it.logicalKey }
        val incoming = snapshot.connections.associate { row ->
            row.id to StoredSpec(row, refs[row.id])
        }
        latestSpecs = incoming
        suppressedBySuccessfulRemove.retainAll(incoming.keys)

        (entries.keys - incoming.keys).forEach { connectionId ->
            entries.remove(connectionId)?.let(::stop)
            desiredBeforeDiscovery -= connectionId
            removeStatus(connectionId)
        }

        incoming.forEach { (connectionId, spec) ->
            if (connectionId in suppressedBySuccessfulRemove) return@forEach
            val existing = entries[connectionId]
            if (existing == null) {
                val desired = desiredBeforeDiscovery.remove(connectionId) ?: spec.eligibleForAutoConnect
                val entry = Entry(spec, allocateGeneration(), desired)
                entries[connectionId] = entry
                setStatus(
                    connectionId,
                    ConnectionRuntimeState(entry.generation, ConnectionStatus.Disconnected, ""),
                )
                if (desired) start(entry)
            } else if (existing.spec != spec) {
                stop(existing)
                existing.spec = spec
                existing.generation = allocateGeneration()
                setStatus(
                    connectionId,
                    ConnectionRuntimeState(existing.generation, ConnectionStatus.Disconnected, ""),
                )
                if (existing.desiredConnected) start(existing)
            }
        }
    }

    private fun createKnownEntry(connectionId: String, desiredConnected: Boolean): Entry? {
        val spec = latestSpecs[connectionId] ?: return null
        return Entry(spec, allocateGeneration(), desiredConnected).also { entry ->
            entries[connectionId] = entry
            setStatus(
                connectionId,
                ConnectionRuntimeState(entry.generation, ConnectionStatus.Disconnected, ""),
            )
        }
    }

    private fun start(entry: Entry) {
        val connectionId = entry.spec.row.id
        val generation = allocateGeneration()
        entry.generation = generation
        setStatus(connectionId, ConnectionRuntimeState(generation, ConnectionStatus.Connecting, ""))
        val resolution = try {
            targetResolver.resolve(connectionId)
        } catch (exception: Exception) {
            setStatus(
                connectionId,
                ConnectionRuntimeState(
                    generation,
                    ConnectionStatus.Error,
                    exception.message ?: "Could not resolve connection target",
                ),
            )
            return
        }
        when (resolution) {
            is ConnectionTargetResolution.Failure -> setStatus(
                connectionId,
                ConnectionRuntimeState(generation, ConnectionStatus.Error, resolution.message),
            )
            is ConnectionTargetResolution.Ready -> {
                if (resolution.target.connectionId != connectionId) {
                    setStatus(
                        connectionId,
                        ConnectionRuntimeState(generation, ConnectionStatus.Error, "Resolved target does not match machine"),
                    )
                    return
                }
                val coordinator = try {
                    coordinatorFactory.create(connectionId, generation) { event ->
                        runtimeEvent(connectionId, generation, event)
                    }
                } catch (exception: Exception) {
                    setStatus(
                        connectionId,
                        ConnectionRuntimeState(
                            generation,
                            ConnectionStatus.Error,
                            exception.message ?: "Could not create connection",
                        ),
                    )
                    return
                }
                entry.coordinator = coordinator
                try {
                    coordinator.connect(resolution.target)
                } catch (exception: Exception) {
                    runCatching(coordinator::destroy)
                    if (entry.coordinator === coordinator) entry.coordinator = null
                    setStatus(
                        connectionId,
                        ConnectionRuntimeState(
                            generation,
                            ConnectionStatus.Error,
                            exception.message ?: "Could not connect",
                        ),
                    )
                }
            }
        }
    }

    @Synchronized
    private fun runtimeEvent(
        connectionId: String,
        coordinatorGeneration: Long,
        event: ConnectionRuntimeEvent,
    ) {
        if (closed || event.generation != coordinatorGeneration) return
        val entry = entries[connectionId] ?: return
        if (entry.generation != coordinatorGeneration || !entry.desiredConnected) return
        val reduced = ConnectionStatusReducer.reduce(
            mutableStatuses.value[connectionId],
            event,
        ) ?: return
        setStatus(connectionId, reduced)
    }

    private fun stopAndInvalidate(entry: Entry, detail: String) {
        val coordinator = entry.coordinator
        entry.coordinator = null
        entry.generation = allocateGeneration()
        setStatus(
            entry.spec.row.id,
            ConnectionRuntimeState(entry.generation, ConnectionStatus.Disconnected, detail),
        )
        if (coordinator != null) {
            runCatching(coordinator::disconnect)
            runCatching(coordinator::destroy)
        }
    }

    private fun stop(entry: Entry) {
        val coordinator = entry.coordinator
        entry.coordinator = null
        if (coordinator != null) {
            runCatching(coordinator::disconnect)
            runCatching(coordinator::destroy)
        }
    }

    private fun allocateGeneration(): Long = ++nextGeneration

    private fun setStatus(connectionId: String, state: ConnectionRuntimeState) {
        mutableStatuses.value = mutableStatuses.value + (connectionId to state)
    }

    private fun removeStatus(connectionId: String) {
        mutableStatuses.value = mutableStatuses.value - connectionId
    }

    private companion object {
        const val WEBSOCKET_KIND = "ws"
    }
}
