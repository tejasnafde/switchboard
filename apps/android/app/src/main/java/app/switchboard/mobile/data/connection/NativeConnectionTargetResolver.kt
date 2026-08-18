package app.switchboard.mobile.data.connection

import app.switchboard.mobile.platform.protocol.WebSocketTarget
import app.switchboard.mobile.platform.protocol.withoutEmbeddedAuth
import app.switchboard.mobile.platform.storage.NativeCredential
import app.switchboard.mobile.protocol.Credential

sealed interface ConnectionTargetResolution {
    data class Ready(val target: WebSocketTarget) : ConnectionTargetResolution
    data class Failure(val message: String) : ConnectionTargetResolution
}

class NativeConnectionTargetResolver(
    private val database: ConnectionDatabase,
    private val credentials: ConnectionCredentialStore,
) {
    fun resolve(
        connectionId: String,
        deviceId: String,
        deviceLabel: String,
    ): ConnectionTargetResolution = try {
        val stored = database.find(connectionId)
            ?: return ConnectionTargetResolution.Failure("That machine no longer exists")
        val row = stored.connection
        if (row.kind != WEBSOCKET_KIND || row.url.isNullOrBlank()) {
            return ConnectionTargetResolution.Failure("That machine does not have a WebSocket target")
        }
        val logicalKey = stored.activeCredentialKey
            ?: return ConnectionTargetResolution.Failure("That machine has no active credential")
        val native = credentials.read(logicalKey)
            ?: return ConnectionTargetResolution.Failure("The saved credential could not be read")
        ConnectionTargetResolution.Ready(
            WebSocketTarget(
                deviceId = deviceId,
                connectionId = connectionId,
                url = withoutEmbeddedAuth(row.url),
                credential = native.toTransportCredential(deviceLabel),
                credentialRef = logicalKey,
            ),
        )
    } catch (_: Exception) {
        ConnectionTargetResolution.Failure("The saved machine could not be opened")
    }

    private companion object {
        const val WEBSOCKET_KIND = "ws"
    }
}

private fun NativeCredential.toTransportCredential(deviceLabel: String): Credential = when (kind) {
    NativeCredential.Kind.DEVICE_SESSION -> Credential.Session(value)
    NativeCredential.Kind.PAIRING_TOKEN -> Credential.Pairing(value, deviceLabel)
    NativeCredential.Kind.LEGACY_INLINE_TOKEN -> Credential.LegacySharedToken(value)
}
