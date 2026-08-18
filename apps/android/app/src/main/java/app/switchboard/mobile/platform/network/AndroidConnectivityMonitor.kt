package app.switchboard.mobile.platform.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import java.io.Closeable

/** Application-scoped network monitor that deliberately ignores WAN validation. */
class AndroidConnectivityMonitor private constructor(
    private val manager: ConnectivityManager,
    private val observer: (Boolean) -> Unit,
) : Closeable {
    private var closed = false
    private var registered = false
    private var lastReported: Boolean? = null
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = reportCurrent()
        override fun onLost(network: Network) = reportCurrent()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = reportCurrent()
    }

    private fun start() {
        val request = allUsableNetworksRequest()
        manager.registerNetworkCallback(request, callback)
        registered = true
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
        } catch (_: RuntimeException) {
            null
        }
        val reachable = NetworkReachabilityPolicy.isReachable(snapshot)
        synchronized(this) {
            if (closed || lastReported == reachable) return
            lastReported = reachable
        }
        runCatching { observer(reachable) }
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        if (registered) runCatching { manager.unregisterNetworkCallback(callback) }
        registered = false
    }

    companion object {
        fun install(
            context: Context,
            observer: (Boolean) -> Unit,
        ): AndroidConnectivityMonitor {
            val manager = context.applicationContext
                .getSystemService(ConnectivityManager::class.java)
            return AndroidConnectivityMonitor(manager, observer).also { monitor ->
                runCatching(monitor::start).onFailure { runCatching { observer(true) } }
            }
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
