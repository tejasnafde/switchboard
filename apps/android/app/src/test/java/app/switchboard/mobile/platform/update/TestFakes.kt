package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateState
import app.switchboard.mobile.update.VerifiedApk
import java.util.concurrent.CountDownLatch
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine

internal class MemoryUpdateStatePersistence(
    initialState: UpdateState? = null,
) : UpdateStatePersistence {
    private var loaded = initialState
    var saved: UpdateState? = initialState
        private set

    override fun load(): UpdateState? = loaded

    override fun save(state: UpdateState) {
        loaded = state
        saved = state
    }
}

internal class MemoryPendingInstallationPersistence(
    initial: PendingInstallation? = null,
) : PendingInstallationPersistence {
    var pending: PendingInstallation? = initial
        private set

    override fun load(): PendingInstallation? = pending

    override fun save(pendingInstallation: PendingInstallation) {
        pending = pendingInstallation
    }

    override fun clear() {
        pending = null
    }
}

internal fun verifiedApk(release: UpdateRelease) = VerifiedApk(
    release = release,
    filePath = "/cache/updates/switchboard.apk",
    contentUri = "content://app.switchboard.mobile.files/updates/switchboard.apk",
)

internal fun <T> runSuspendTest(operation: suspend () -> T): T {
    val completed = CountDownLatch(1)
    var outcome: Result<T>? = null
    operation.startCoroutine(
        object : Continuation<T> {
            override val context = EmptyCoroutineContext

            override fun resumeWith(result: Result<T>) {
                outcome = result
                completed.countDown()
            }
        },
    )
    completed.await()
    return requireNotNull(outcome).getOrThrow()
}
