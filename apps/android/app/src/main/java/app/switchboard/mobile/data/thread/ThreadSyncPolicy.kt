package app.switchboard.mobile.data.thread

sealed interface ThreadOperationResult<out T> {
    data class Success<T>(val value: T) : ThreadOperationResult<T>
    data class Failure(val message: String) : ThreadOperationResult<Nothing>
}

data class ThreadSyncResult<C, F>(
    val command: ThreadOperationResult<C>,
    val followUp: ThreadOperationResult<F>?,
)

object ThreadSyncPolicy {
    fun <C, F> afterCommand(
        command: ThreadOperationResult<C>,
        followUp: () -> ThreadOperationResult<F>,
    ): ThreadSyncResult<C, F> =
        if (command is ThreadOperationResult.Failure) {
            ThreadSyncResult(command, null)
        } else {
            ThreadSyncResult(command, followUp())
        }
}
