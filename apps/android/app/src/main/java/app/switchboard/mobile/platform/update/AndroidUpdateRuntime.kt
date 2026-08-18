package app.switchboard.mobile.platform.update

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateState
import java.io.File
import java.util.concurrent.Executors

class AndroidUpdateRuntime(
    context: Context,
) {
    private val applicationContext = context.applicationContext
    private val mainThread = MainThreadDispatcher()
    private val identityReader = AndroidPackageIdentityReader(applicationContext)
    private val pendingPersistence = SharedPreferencesPendingInstallationPersistence(applicationContext)
    private val pendingTracker = PendingInstallationTracker(pendingPersistence)
    private val executor = Executors.newFixedThreadPool(UPDATE_WORKER_COUNT) { task ->
        Thread(task, "switchboard-update").apply { isDaemon = true }
    }
    private val identity = UpdateRuntimeIdentity(
        packageName = applicationContext.packageName,
        debuggable = applicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0,
    )
    private val stateValue = mutableStateOf<UpdateState>(UpdateState.Idle)
    private val pendingStatusValue = mutableStateOf<PendingInstallationStatus>(PendingInstallationStatus.None)
    private val controller: UpdateController
    private val interactions: UpdateInteractionCoordinator
    private val startup: UpdateRuntimeStartup

    val state: State<UpdateState> = stateValue
    val pendingInstallationStatus: State<PendingInstallationStatus> = pendingStatusValue
    val enabled: Boolean
        get() = startup.enabled

    init {
        val downloader = HttpUpdateDownloader(File(applicationContext.cacheDir, UPDATES_DIRECTORY))
        val verifier = AndroidUpdateVerifier(applicationContext, identityReader)
        val installer = AndroidUpdateInstaller(
            context = applicationContext,
            packageIdentityReader = identityReader,
            pendingInstallationPersistence = pendingPersistence,
        )
        val runner = DefaultUpdateEffectRunner(
            releaseSource = GitHubUpdateReleaseSource(),
            downloader = downloader,
            verifier = verifier,
            installer = installer,
            executor = executor,
        )

        lateinit var interactionReference: UpdateInteractionCoordinator
        controller = UpdateController(
            currentVersion = currentVersionName(),
            effectRunner = runner,
            persistence = SharedPreferencesUpdateStatePersistence(applicationContext),
            onStateChanged = { updateState ->
                mainThread.dispatch {
                    stateValue.value = updateState
                    interactionReference.onStateChanged(updateState)
                }
            },
        )
        interactions = UpdateInteractionCoordinator(
            state = { controller.state },
            dispatch = controller::dispatch,
            installerReturned = controller::installerReturned,
        )
        interactionReference = interactions
        startup = UpdateRuntimeStartup(
            identity = identity,
            inspectPendingInstallation = {
                val status = pendingTracker.inspect(identityReader.installed())
                mainThread.dispatch { pendingStatusValue.value = status }
            },
            startController = controller::start,
        )
        if (startup.enabled) stateValue.value = controller.state
    }

    fun start() {
        startup.start()
    }

    fun onAction(action: UpdateAction) {
        if (startup.enabled) interactions.onAction(action)
    }

    fun onActivityPaused() {
        if (startup.enabled) interactions.onActivityPaused()
    }

    fun onActivityResumed() {
        if (startup.enabled) interactions.onActivityResumed()
    }

    @Suppress("DEPRECATION")
    private fun currentVersionName(): String = applicationContext.packageManager
        .getPackageInfo(applicationContext.packageName, 0)
        .versionName
        .orEmpty()
        .ifEmpty { "0.0.0" }

    private class MainThreadDispatcher {
        private val handler = Handler(Looper.getMainLooper())

        fun dispatch(operation: () -> Unit) {
            if (Looper.myLooper() == handler.looper) {
                operation()
            } else {
                handler.post(operation)
            }
        }
    }

    private companion object {
        const val UPDATES_DIRECTORY = "updates"
        const val UPDATE_WORKER_COUNT = 3
    }
}
