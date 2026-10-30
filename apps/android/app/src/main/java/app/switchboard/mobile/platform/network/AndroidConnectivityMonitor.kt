package app.switchboard.mobile.platform.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import app.switchboard.mobile.platform.log.SbLog
import java.io.Closeable

/** The ConnectivityManager calls the monitor makes, so a test can drive them. */
internal interface ConnectivitySource {
    val allNetworks: Array<Network>
    val activeNetwork: Network?

    fun getNetworkCapabilities(network: Network): NetworkCapabilities?

    fun registerNetworkCallback(request: NetworkRequest, callback: ConnectivityManager.NetworkCallback)

    fun registerDefaultNetworkCallback(callback: ConnectivityManager.NetworkCallback)

    fun unregisterNetworkCallback(callback: ConnectivityManager.NetworkCallback)
}

private class ManagerConnectivitySource(private val manager: ConnectivityManager) : ConnectivitySource {
    override val allNetworks: Array<Network> get() = manager.allNetworks
    override val activeNetwork: Network? get() = manager.activeNetwork

    override fun getNetworkCapabilities(network: Network) = manager.getNetworkCapabilities(network)

    override fun registerNetworkCallback(request: NetworkRequest, callback: ConnectivityManager.NetworkCallback) =
        manager.registerNetworkCallback(request, callback)

    override fun registerDefaultNetworkCallback(callback: ConnectivityManager.NetworkCallback) =
        manager.registerDefaultNetworkCallback(callback)

    override fun unregisterNetworkCallback(callback: ConnectivityManager.NetworkCallback) =
        manager.unregisterNetworkCallback(callback)
}

/** Application-scoped network monitor that deliberately ignores WAN validation. */
class AndroidConnectivityMonitor private constructor(
    private val manager: ConnectivitySource,
    private val observer: (Boolean) -> Unit,
    private val onRouteChanged: () -> Unit,
) : Closeable {
    private var closed = false
    private var registered = false
    private var defaultRegistered = false
    private var lastReported: Boolean? = null
    private var lastRoute: String? = null

    /** Availability of any network, the default one or not. */
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = reportCurrent()
        override fun onLost(network: Network) = reportCurrent()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = reportCurrent()
    }

    /**
     * Changes of the default network. With two networks up, Android can move
     * the default route without any availability change, so the callback
     * above need not fire and the socket would stay on the old route.
     */
    private val defaultCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = reportCurrent()
        override fun onLost(network: Network) = reportCurrent()
    }

    private fun start() {
        val request = allUsableNetworksRequest()
        manager.registerNetworkCallback(request, callback)
        registered = true
        manager.registerDefaultNetworkCallback(defaultCallback)
        defaultRegistered = true
        reportCurrent()
    }

    private fun reportCurrent() {
        val snapshot = try {
            val networks = manager.allNetworks
            val capabilities = networks.mapNotNull(manager::getNetworkCapabilities)
            when {
                networks.isEmpty() -> NetworkSnapshot(hasTransport = false, validatedInternet = false)
                capabilities.isEmpty() -> null
                else -> NetworkSnapshot(
                    hasTransport = capabilities.any(::hasUsableTransport),
                    validatedInternet = capabilities.any {
                        it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    },
                )
            }
        } catch (error: RuntimeException) {
            SbLog.w(LOG_SCOPE, "could not read network capabilities: ${SbLog.describe(error)}")
            null
        }
        val reachable = NetworkReachabilityPolicy.isReachable(snapshot)
        val route = try {
            manager.activeNetwork?.toString()
        } catch (error: RuntimeException) {
            SbLog.w(LOG_SCOPE, "could not read the default network", error)
            null
        }
        val (reachabilityChanged, routeChanged) = synchronized(this) {
            if (closed) return
            val routeMoved = NetworkReachabilityPolicy.routeChanged(lastRoute, route)
            if (route != null) lastRoute = route
            val changed = lastReported != reachable
            lastReported = reachable
            changed to routeMoved
        }
        if (reachabilityChanged) {
            SbLog.i(LOG_SCOPE, "reachable=$reachable transport=${snapshot?.hasTransport} validated=${snapshot?.validatedInternet}")
            runCatching { observer(reachable) }.onFailure { SbLog.w(LOG_SCOPE, "network observer failed", it) }
        }
        if (routeChanged) {
            SbLog.i(LOG_SCOPE, "default network moved")
            runCatching(onRouteChanged).onFailure { SbLog.w(LOG_SCOPE, "network route observer failed", it) }
        }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        if (registered) runCatching { manager.unregisterNetworkCallback(callback) }
        if (defaultRegistered) runCatching { manager.unregisterNetworkCallback(defaultCallback) }
        registered = false
        defaultRegistered = false
    }

    companion object {
        private const val LOG_SCOPE = "network"

        fun install(
            context: Context,
            observer: (Boolean) -> Unit,
            onRouteChanged: () -> Unit = {},
        ): AndroidConnectivityMonitor {
            val manager = context.applicationContext
                .getSystemService(ConnectivityManager::class.java)
            return install(ManagerConnectivitySource(manager), observer, onRouteChanged)
        }

        internal fun install(
            source: ConnectivitySource,
            observer: (Boolean) -> Unit,
            onRouteChanged: () -> Unit,
        ): AndroidConnectivityMonitor =
            AndroidConnectivityMonitor(source, observer, onRouteChanged).also { monitor ->
                runCatching(monitor::start).onFailure { runCatching { observer(true) } }
            }

        private fun hasUsableTransport(capabilities: NetworkCapabilities): Boolean =
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)

        private fun allUsableNetworksRequest(): NetworkRequest {
            val builder = NetworkRequest.Builder()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.clearCapabilities()
            } else {
                // clearCapabilities() was added in API 30. These are the
                // capabilities NetworkRequest.Builder supplied by default on
                // API 24-29; removing them keeps local-only LAN transports in
                // the callback without requiring validated internet access.
                builder.removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
                builder.removeCapability(NetworkCapabilities.NET_CAPABILITY_TRUSTED)
                builder.removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            }
            return builder.build()
        }
    }
}
