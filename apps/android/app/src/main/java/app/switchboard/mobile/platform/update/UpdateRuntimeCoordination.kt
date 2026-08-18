package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateEvent
import app.switchboard.mobile.update.UpdateState

object UpdateActionMapper {
    fun eventFor(action: UpdateAction): UpdateEvent = when (action) {
        UpdateAction.CHECK -> UpdateEvent.CheckRequested
        UpdateAction.DOWNLOAD -> UpdateEvent.DownloadRequested
        UpdateAction.CANCEL -> UpdateEvent.CancelRequested
        UpdateAction.INSTALL -> UpdateEvent.InstallRequested
        UpdateAction.OPEN_SETTINGS -> UpdateEvent.OpenPermissionSettingsRequested
        UpdateAction.RETRY -> UpdateEvent.RetryRequested
    }
}

class UpdateInteractionCoordinator(
    private val state: () -> UpdateState,
    private val dispatch: (UpdateEvent) -> Unit,
    private val installerReturned: () -> Unit,
) {
    private val lock = Any()
    private var firstResume = true
    private var pendingHandoff: ExternalHandoff? = null
    private var pausedSinceHandoff = false
    private var activityPaused = false

    fun onAction(action: UpdateAction) {
        if (action == UpdateAction.OPEN_SETTINGS) {
            synchronized(lock) {
                pendingHandoff = ExternalHandoff.UNKNOWN_SOURCES
                pausedSinceHandoff = false
            }
        }
        dispatch(UpdateActionMapper.eventFor(action))
    }

    fun onStateChanged(updateState: UpdateState) {
        synchronized(lock) {
            when (updateState) {
                is UpdateState.LaunchRequested -> {
                    pendingHandoff = ExternalHandoff.INSTALLER
                    pausedSinceHandoff = activityPaused
                }

                is UpdateState.Error -> {
                    pendingHandoff = null
                    pausedSinceHandoff = false
                }

                else -> Unit
            }
        }
    }

    fun onActivityPaused() {
        synchronized(lock) {
            activityPaused = true
            if (pendingHandoff != null) pausedSinceHandoff = true
        }
    }

    fun onActivityResumed() {
        val recovery = synchronized(lock) {
            activityPaused = false
            val pending = pendingHandoff
            when {
                pending != null -> {
                    firstResume = false
                    if (!pausedSinceHandoff) {
                        null
                    } else {
                        pendingHandoff = null
                        pausedSinceHandoff = false
                        pending
                    }
                }

                firstResume -> {
                    firstResume = false
                    ExternalHandoff.UNKNOWN_SOURCES.takeIf { state() is UpdateState.PermissionRequired }
                }

                else -> null
            }
        }

        when (recovery) {
            ExternalHandoff.UNKNOWN_SOURCES -> dispatch(UpdateEvent.PermissionSettingsReturned)
            ExternalHandoff.INSTALLER -> installerReturned()
            null -> Unit
        }
    }

    private enum class ExternalHandoff {
        UNKNOWN_SOURCES,
        INSTALLER,
    }
}

data class UpdateRuntimeIdentity(
    val packageName: String,
    val debuggable: Boolean,
)

class UpdateRuntimeStartup(
    identity: UpdateRuntimeIdentity,
    private val inspectPendingInstallation: () -> Unit,
    private val startController: () -> Unit,
    private val onFailure: (Throwable) -> Unit = {},
) {
    val enabled: Boolean =
        identity.packageName == ArchivePreflightPolicy.PRODUCTION_PACKAGE && !identity.debuggable

    private var started = false

    @Synchronized
    fun start() {
        if (started) return
        started = true
        if (!enabled) return

        try {
            inspectPendingInstallation()
        } catch (failure: Throwable) {
            onFailure(failure)
        }
        try {
            startController()
        } catch (failure: Throwable) {
            onFailure(failure)
        }
    }
}
