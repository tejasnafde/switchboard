package app.switchboard.mobile.platform.push

import app.switchboard.mobile.domain.push.ExpoPushProjectIdentity
import app.switchboard.mobile.domain.push.ExpoPushTokenContract
import app.switchboard.mobile.domain.push.ExpoTokenDecode
import java.io.Closeable

data class PersistedPushToken(
    val fcmToken: String,
    val expoToken: String,
)

interface PushTokenStore {
    fun read(): PersistedPushToken?
    fun write(value: PersistedPushToken): Boolean
}

fun interface ExpoTokenExchange {
    fun exchange(
        identity: ExpoPushProjectIdentity,
        installationId: String,
        fcmToken: String,
        callback: (ExpoTokenDecode) -> Unit,
    )
}

class PushTokenRuntime(
    private val enabled: Boolean,
    private val identity: ExpoPushProjectIdentity,
    private val installationId: () -> String,
    private val store: PushTokenStore,
    private val exchange: ExpoTokenExchange,
    private val publish: (String) -> Unit,
) : Closeable {
    private var generation = 0L
    private var currentFcmToken: String? = null
    private var publishedToken: String? = null
    private var closed = false

    @Synchronized
    fun start() {
        if (!enabled || closed) return
        store.read()
            ?.takeIf { ExpoPushTokenContract.isExpoPushToken(it.expoToken) }
            ?.let { publishIfChanged(it.expoToken) }
    }

    @Synchronized
    fun onFcmToken(fcmToken: String) {
        if (!enabled || closed || fcmToken.isBlank()) return
        currentFcmToken = fcmToken
        val cached = store.read()
        if (cached?.fcmToken == fcmToken && ExpoPushTokenContract.isExpoPushToken(cached.expoToken)) {
            publishIfChanged(cached.expoToken)
            return
        }
        val requestGeneration = ++generation
        val installation = try {
            installationId()
        } catch (_: Exception) {
            return
        }
        exchange.exchange(identity, installation, fcmToken) { result ->
            synchronized(this) {
                if (closed || requestGeneration != generation || currentFcmToken != fcmToken) return@synchronized
                val token = (result as? ExpoTokenDecode.Success)?.token ?: return@synchronized
                store.write(PersistedPushToken(fcmToken, token))
                publishIfChanged(token)
            }
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        generation += 1
    }

    private fun publishIfChanged(token: String) {
        if (publishedToken == token) return
        publishedToken = token
        publish(token)
    }
}
