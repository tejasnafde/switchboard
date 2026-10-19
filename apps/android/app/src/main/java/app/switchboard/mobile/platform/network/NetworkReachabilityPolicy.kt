package app.switchboard.mobile.platform.network

data class NetworkSnapshot(
    val hasTransport: Boolean,
    val validatedInternet: Boolean,
)

object NetworkReachabilityPolicy {
    /** Null is still being determined; WAN validation is irrelevant to LAN. */
    fun isReachable(snapshot: NetworkSnapshot?): Boolean = snapshot?.hasTransport != false

    /**
     * The default network moved (Wi-Fi to cellular, one Wi-Fi to another). A
     * socket dialled over the old one is dead without any error. Losing the
     * network entirely, or getting one back, is the reachability signal's job.
     */
    fun routeChanged(previous: String?, current: String?): Boolean =
        previous != null && current != null && previous != current
}
