package app.switchboard.mobile.platform.network

data class NetworkSnapshot(
    val hasTransport: Boolean,
    val validatedInternet: Boolean,
)

object NetworkReachabilityPolicy {
    /** Null is still being determined; WAN validation is irrelevant to LAN. */
    fun isReachable(snapshot: NetworkSnapshot?): Boolean = snapshot?.hasTransport != false
}
