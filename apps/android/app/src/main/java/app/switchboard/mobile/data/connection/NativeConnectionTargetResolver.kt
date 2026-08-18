package app.switchboard.mobile.data.connection

import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.platform.protocol.LineEndpoint
import app.switchboard.mobile.platform.protocol.LineTarget
import app.switchboard.mobile.platform.protocol.withoutEmbeddedAuth
import app.switchboard.mobile.platform.storage.NativeCredential
import app.switchboard.mobile.protocol.Credential

sealed interface ConnectionTargetResolution {
    data class Ready(val target: LineTarget) : ConnectionTargetResolution
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
        val endpoint = when (row.kind) {
            WEBSOCKET_KIND -> {
                val url = row.url?.takeIf(String::isNotBlank)
                    ?: return ConnectionTargetResolution.Failure("That machine does not have a WebSocket target")
                LineEndpoint.DirectWebSocket(withoutEmbeddedAuth(url))
            }
            IAP_KIND -> {
                val project = row.project?.trim()?.takeIf(String::isNotEmpty)
                val zone = row.zone?.trim()?.takeIf(String::isNotEmpty)
                val instance = row.instance?.trim()?.takeIf(String::isNotEmpty)
                val port = row.port?.takeIf { it in 1..65_535 }
                if (project == null || zone == null || instance == null || port == null) {
                    return ConnectionTargetResolution.Failure("That machine has an invalid Cloud IAP target")
                }
                LineEndpoint.CloudIap(IapTarget(project, zone, instance, port))
            }
            else -> return ConnectionTargetResolution.Failure("That machine has an unsupported connection type")
        }
        val logicalKey = stored.activeCredentialKey
            ?: return ConnectionTargetResolution.Failure("That machine has no active credential")
        val native = credentials.read(logicalKey)
            ?: return ConnectionTargetResolution.Failure("The saved credential could not be read")
        val credential = native.toTransportCredential(deviceLabel)
        if (endpoint is LineEndpoint.CloudIap && credential !is Credential.LegacySharedToken) {
            return ConnectionTargetResolution.Failure("That Cloud IAP machine has no backend credential")
        }
        ConnectionTargetResolution.Ready(
            LineTarget(
                deviceId = deviceId,
                connectionId = connectionId,
                endpoint = endpoint,
                credential = credential,
                credentialRef = logicalKey,
            ),
        )
    } catch (_: Exception) {
        ConnectionTargetResolution.Failure("The saved machine could not be opened")
    }

    private companion object {
        const val WEBSOCKET_KIND = "ws"
        const val IAP_KIND = "iap"
    }
}

private fun NativeCredential.toTransportCredential(deviceLabel: String): Credential = when (kind) {
    NativeCredential.Kind.DEVICE_SESSION -> Credential.Session(value)
    NativeCredential.Kind.PAIRING_TOKEN -> Credential.Pairing(value, deviceLabel)
    NativeCredential.Kind.LEGACY_INLINE_TOKEN -> Credential.LegacySharedToken(value)
}
