package app.switchboard.mobile.ui.thread

object ThreadFeedLayoutPolicy {
    fun <T> declarationOrder(chronological: List<T>): List<T> = chronological.asReversed()
}
