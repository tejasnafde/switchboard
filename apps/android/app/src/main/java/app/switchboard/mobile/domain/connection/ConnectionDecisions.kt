package app.switchboard.mobile.domain.connection

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class PairingTarget(
    val endpoint: String,
    val token: String?,
    val pairingCode: String?,
)

object PairingUrl {
    fun parse(raw: String): PairingTarget? {
        val value = raw.trim()
        if (!value.startsWith("ws://") && !value.startsWith("wss://")) return null
        return runCatching {
            val uri = URI(value)
            if (uri.host.isNullOrBlank()) return null
            val parameters = queryParameters(uri.rawQuery)
            val pairing = parameters.firstOrNull { it.first == "pair" }?.second
            val token = if (pairing == null) {
                parameters.firstOrNull { it.first == "token" }?.second
            } else {
                null
            }
            val endpoint = buildString {
                append(uri.scheme)
                append("://")
                append(uri.rawAuthority)
                append(uri.rawPath.orEmpty())
                uri.rawFragment?.let {
                    append('#')
                    append(it)
                }
            }.let {
                if (it.endsWith('/')) it.dropLast(1) else it
            }
            PairingTarget(endpoint, token, pairing)
        }.getOrNull()
    }

    private fun queryParameters(query: String?): List<Pair<String, String>> =
        query.orEmpty()
            .split('&')
            .filter(String::isNotEmpty)
            .map { field ->
                val separator = field.indexOf('=')
                val key = if (separator < 0) field else field.substring(0, separator)
                val value = if (separator < 0) "" else field.substring(separator + 1)
                decode(key) to decode(value)
            }

    private fun decode(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
}

enum class ForegroundAction {
    Probe,
    Reconnect,
}

object ConnectionLifecycle {
    const val ReconnectAfterMs = 10_000L

    fun foregroundAction(backgroundedAtMs: Long?, activeAtMs: Long): ForegroundAction =
        if (backgroundedAtMs != null && activeAtMs - backgroundedAtMs >= ReconnectAfterMs) {
            ForegroundAction.Reconnect
        } else {
            ForegroundAction.Probe
        }

    /** LAN backends remain reachable without platform-validated internet. */
    fun canReachLocalBackend(isConnected: Boolean?): Boolean = isConnected != false
}

data class IapTarget(
    val project: String,
    val zone: String,
    val instance: String,
    val port: Int,
)

sealed class IapTargetError : IllegalArgumentException() {
    data object MissingDetails : IapTargetError()

    data object InvalidPort : IapTargetError()
}

object IapTargetValidator {
    fun validate(
        project: String,
        zone: String,
        instance: String,
        port: String,
    ): Result<IapTarget> {
        val normalizedProject = project.trim()
        val normalizedZone = zone.trim()
        val normalizedInstance = instance.trim()
        if (normalizedProject.isEmpty() || normalizedZone.isEmpty() || normalizedInstance.isEmpty()) {
            return Result.failure(IapTargetError.MissingDetails)
        }
        val parsedPort = port.toIntOrNull()
        if (parsedPort == null || parsedPort !in 1..65_535) {
            return Result.failure(IapTargetError.InvalidPort)
        }
        return Result.success(IapTarget(normalizedProject, normalizedZone, normalizedInstance, parsedPort))
    }
}

enum class ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

data class ConnectionRuntimeState(
    val generation: Long,
    val status: ConnectionStatus,
    val detail: String,
)

sealed interface ConnectionRuntimeEvent {
    val generation: Long

    data class Begin(override val generation: Long) : ConnectionRuntimeEvent

    data class Ready(override val generation: Long) : ConnectionRuntimeEvent

    data class Retrying(
        override val generation: Long,
        val closeCode: Int?,
        val attempt: Int,
    ) : ConnectionRuntimeEvent

    data class Stopped(
        override val generation: Long,
        val authenticationRejected: Boolean,
    ) : ConnectionRuntimeEvent

    data class Disconnected(override val generation: Long) : ConnectionRuntimeEvent
}

object ConnectionStatusReducer {
    fun reduce(
        current: ConnectionRuntimeState?,
        event: ConnectionRuntimeEvent,
    ): ConnectionRuntimeState? {
        if (event is ConnectionRuntimeEvent.Begin) {
            if (current != null && event.generation <= current.generation) return current
        } else {
            if (current == null || event.generation != current.generation) return current
        }
        return when (event) {
            is ConnectionRuntimeEvent.Begin -> ConnectionRuntimeState(
                generation = event.generation,
                status = ConnectionStatus.Connecting,
                detail = "",
            )
            is ConnectionRuntimeEvent.Ready -> ConnectionRuntimeState(
                generation = event.generation,
                status = ConnectionStatus.Connected,
                detail = "",
            )
            is ConnectionRuntimeEvent.Retrying -> ConnectionRuntimeState(
                generation = event.generation,
                status = ConnectionStatus.Connecting,
                detail = event.closeCode?.let { "dropped ($it), retry ${event.attempt}" }
                    ?: "retry ${event.attempt}",
            )
            is ConnectionRuntimeEvent.Stopped -> ConnectionRuntimeState(
                generation = event.generation,
                status = if (event.authenticationRejected) ConnectionStatus.Error else ConnectionStatus.Disconnected,
                detail = if (event.authenticationRejected) "token rejected - re-pair" else "offline",
            )
            is ConnectionRuntimeEvent.Disconnected -> ConnectionRuntimeState(
                generation = event.generation,
                status = ConnectionStatus.Disconnected,
                detail = "",
            )
        }
    }
}
