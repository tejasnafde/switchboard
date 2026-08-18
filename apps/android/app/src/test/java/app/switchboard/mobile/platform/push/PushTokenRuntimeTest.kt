package app.switchboard.mobile.platform.push

import app.switchboard.mobile.domain.push.ExpoPushProjectIdentity
import app.switchboard.mobile.domain.push.ExpoTokenDecode
import org.junit.Assert.assertEquals
import org.junit.Test

class PushTokenRuntimeTest {
    @Test
    fun `matching cached mapping publishes without another exchange`() {
        val store = FakeStore(PersistedPushToken("fcm-a", "ExpoPushToken[expo-a]"))
        val exchange = FakeExchange()
        val published = mutableListOf<String>()
        val runtime = PushTokenRuntime(
            enabled = true,
            identity = identity,
            installationId = { "install-a" },
            store = store,
            exchange = exchange,
            publish = published::add,
        )

        runtime.start()
        runtime.onFcmToken("fcm-a")

        assertEquals(listOf("ExpoPushToken[expo-a]"), published)
        assertEquals(0, exchange.requests.size)
    }

    @Test
    fun `rotated FCM token exchanges and only current callback can publish`() {
        val store = FakeStore(PersistedPushToken("fcm-old", "ExpoPushToken[expo-old]"))
        val exchange = FakeExchange()
        val published = mutableListOf<String>()
        val runtime = PushTokenRuntime(
            enabled = true,
            identity = identity,
            installationId = { "install-a" },
            store = store,
            exchange = exchange,
            publish = published::add,
        )
        runtime.start()

        runtime.onFcmToken("fcm-one")
        runtime.onFcmToken("fcm-two")
        exchange.complete(0, ExpoTokenDecode.Success("ExpoPushToken[stale]"))
        exchange.complete(1, ExpoTokenDecode.Success("ExpoPushToken[current]"))

        assertEquals(
            listOf("ExpoPushToken[expo-old]", "ExpoPushToken[current]"),
            published,
        )
        assertEquals(PersistedPushToken("fcm-two", "ExpoPushToken[current]"), store.value)
    }

    @Test
    fun `disabled debug and exchange failures remain nonfatal`() {
        val store = FakeStore(null)
        val exchange = FakeExchange()
        val published = mutableListOf<String>()
        val disabled = PushTokenRuntime(
            enabled = false,
            identity = identity,
            installationId = { error("debug must not create Expo identity") },
            store = store,
            exchange = exchange,
            publish = published::add,
        )
        disabled.start()
        disabled.onFcmToken("fcm-debug")
        assertEquals(0, exchange.requests.size)

        val enabled = PushTokenRuntime(
            enabled = true,
            identity = identity,
            installationId = { "install-a" },
            store = store,
            exchange = exchange,
            publish = published::add,
        )
        enabled.onFcmToken("fcm-release")
        exchange.complete(0, ExpoTokenDecode.Failure("offline"))
        assertEquals(emptyList<String>(), published)
        assertEquals(null, store.value)
    }

    private class FakeStore(initial: PersistedPushToken?) : PushTokenStore {
        var value = initial
        override fun read(): PersistedPushToken? = value
        override fun write(value: PersistedPushToken): Boolean {
            this.value = value
            return true
        }
    }

    private class FakeExchange : ExpoTokenExchange {
        data class Request(
            val fcmToken: String,
            val callback: (ExpoTokenDecode) -> Unit,
        )

        val requests = mutableListOf<Request>()

        override fun exchange(
            identity: ExpoPushProjectIdentity,
            installationId: String,
            fcmToken: String,
            callback: (ExpoTokenDecode) -> Unit,
        ) {
            requests += Request(fcmToken, callback)
        }

        fun complete(index: Int, result: ExpoTokenDecode) = requests[index].callback(result)
    }

    private companion object {
        val identity = ExpoPushProjectIdentity("project", "app.switchboard.mobile")
    }
}
