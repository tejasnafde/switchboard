package app.switchboard.mobile.platform.network

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidConnectivityMonitorTest {
    private class FakeSource : ConnectivitySource {
        override var allNetworks: Array<Network> = emptyArray()
        override var activeNetwork: Network? = null
        val networkCallbacks = mutableListOf<ConnectivityManager.NetworkCallback>()
        val defaultCallbacks = mutableListOf<ConnectivityManager.NetworkCallback>()

        override fun getNetworkCapabilities(network: Network): NetworkCapabilities? = null

        override fun registerNetworkCallback(request: NetworkRequest, callback: ConnectivityManager.NetworkCallback) {
            networkCallbacks += callback
        }

        override fun registerDefaultNetworkCallback(callback: ConnectivityManager.NetworkCallback) {
            defaultCallbacks += callback
        }

        override fun unregisterNetworkCallback(callback: ConnectivityManager.NetworkCallback) {
            networkCallbacks -= callback
            defaultCallbacks -= callback
        }
    }

    @Test
    fun `a default network switch with both networks still up reports a route change`() {
        val wifi = ShadowNetwork.newInstance(100)
        val cellular = ShadowNetwork.newInstance(101)
        val source = FakeSource().apply {
            allNetworks = arrayOf(wifi, cellular)
            activeNetwork = wifi
        }
        var routeChanges = 0
        val monitor = AndroidConnectivityMonitor.install(source, observer = {}, onRouteChanged = { routeChanges++ })
        assertEquals(1, source.defaultCallbacks.size)

        // Only the default changes: no network appears or disappears.
        source.activeNetwork = cellular
        source.defaultCallbacks.single().onAvailable(cellular)

        assertEquals(1, routeChanges)
        monitor.close()
        assertTrue(source.networkCallbacks.isEmpty())
        assertTrue(source.defaultCallbacks.isEmpty())
    }
}
