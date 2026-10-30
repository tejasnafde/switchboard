package app.switchboard.mobile.data.connection

import app.switchboard.mobile.domain.connection.CleartextPolicy
import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.platform.log.SbLog
import app.switchboard.mobile.platform.protocol.LineEndpoint
import app.switchboard.mobile.platform.protocol.LineTarget
import app.switchboard.mobile.platform.protocol.withoutEmbeddedAuth
import app.switchboard.mobile.platform.storage.NativeCredential
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.DeviceIdentityPayload

sealed interface ConnectionTargetResolution {
    data class Ready(val target: LineTarget) : ConnectionTargetResolution
    /**
     * [retryable] failures (a database or keystore read that threw, a key that
     * is locked) can pass on a later try; the others need the user to act.
     */
    data class Failure(val message: String, val retryable: Boolean = false) : ConnectionTargetResolution
}

class NativeConnectionTargetResolver(
    private val database: ConnectionDatabase,
    private val credentials: ConnectionCredentialStore,
    /** Release builds: plain ws:// only to loopback (the dial would also hit the
     *  network security config; this names the fix instead of a socket error). */
    private val requireEncryption: Boolean,
) {
    fun resolve(
        connectionId: String,
        deviceId: String,
        deviceLabel: String,
        device: DeviceIdentityPayload? = null,
    ): ConnectionTargetResolution = resolveOrThrow(connectionId, deviceId, deviceLabel, device).also { result ->
        if (result is ConnectionTargetResolution.Failure) {
            SbLog.w(LOG_SCOPE, "resolve $connectionId failed (retryable=${result.retryable}): ${result.message}")
        }
    }

    private fun resolveOrThrow(
        connectionId: String,
        deviceId: String,
        deviceLabel: String,
        device: DeviceIdentityPayload?,
    ): ConnectionTargetResolution = try {
        val stored = database.find(connectionId)
            ?: return ConnectionTargetResolution.Failure("That machine no longer exists")
        val row = stored.connection
        val endpoint = when (row.kind) {
            WEBSOCKET_KIND -> {
                val url = row.url?.takeIf(String::isNotBlank)
                    ?: return ConnectionTargetResolution.Failure("That machine does not have a WebSocket target")
                if (requireEncryption && CleartextPolicy.refuses(url)) {
                    return ConnectionTargetResolution.Failure(CleartextPolicy.REFUSED_MESSAGE)
                }
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
            ?: return ConnectionTargetResolution.Failure("The saved credential could not be read", retryable = true)
        val credential = native.toTransportCredential(deviceLabel, device)
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
    } catch (exception: IllegalArgumentException) {
        // A stored URL that does not parse; a later try reads the same row.
        SbLog.w(LOG_SCOPE, "resolve $connectionId: invalid target ${SbLog.describe(exception)}")
        ConnectionTargetResolution.Failure("That machine has an invalid address")
    } catch (exception: Exception) {
        SbLog.w(LOG_SCOPE, "resolve $connectionId threw ${SbLog.describe(exception)}")
        ConnectionTargetResolution.Failure("The saved machine could not be opened", retryable = true)
    }

    private companion object {
        const val LOG_SCOPE = "resolver"
        const val WEBSOCKET_KIND = "ws"
        const val IAP_KIND = "iap"
    }
}

private fun NativeCredential.toTransportCredential(
    deviceLabel: String,
    device: DeviceIdentityPayload?,
): Credential = when (kind) {
    NativeCredential.Kind.DEVICE_SESSION -> Credential.Session(value, device)
    NativeCredential.Kind.PAIRING_TOKEN -> Credential.Pairing(value, deviceLabel, device)
    NativeCredential.Kind.LEGACY_INLINE_TOKEN -> Credential.LegacySharedToken(value)
}
