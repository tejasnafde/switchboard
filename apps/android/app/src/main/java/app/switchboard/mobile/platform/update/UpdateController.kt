package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateEffect
import app.switchboard.mobile.update.UpdateEvent
import app.switchboard.mobile.update.UpdateStage
import app.switchboard.mobile.update.UpdateState
import app.switchboard.mobile.update.UpdateStateMachine

interface UpdateEffectRunner {
    fun run(effect: UpdateEffect, emit: (UpdateEvent) -> Unit)
}

interface UpdateStatePersistence {
    fun load(): UpdateState?

    fun save(state: UpdateState)
}

class UpdateController(
    currentVersion: String,
    private val effectRunner: UpdateEffectRunner,
    private val persistence: UpdateStatePersistence,
    private val onStateChanged: (UpdateState) -> Unit = {},
    private val onPersistenceFailure: (Throwable) -> Unit = {},
) {
    private val lock = Any()
    private val machine = UpdateStateMachine(currentVersion, loadState())
    private var started = false
    private var nextEffectToken = 0L
    private var activeEffectToken: Long? = null

    val state: UpdateState
        get() = synchronized(lock) { machine.state }

    fun start() {
        val outcome = synchronized(lock) {
            if (started) return
            started = true

            when (val current = machine.state) {
                UpdateState.Idle,
                UpdateState.UpToDate,
                -> applyEventLocked(UpdateEvent.CheckRequested)
                UpdateState.Checking -> launchEffectLocked(UpdateEffect.FetchReleases)
                is UpdateState.Downloading -> launchEffectLocked(UpdateEffect.StartDownload(current.release))
                is UpdateState.Cancelling -> launchEffectLocked(UpdateEffect.CancelDownload)
                is UpdateState.Verifying -> launchEffectLocked(UpdateEffect.VerifyDownload(current.downloadedApk))
                is UpdateState.CheckingInstallPermission -> launchEffectLocked(UpdateEffect.CheckInstallPermission)
                is UpdateState.LaunchRequested -> {
                    val recovered = UpdateState.InstallerReady(current.artifact)
                    machine.restore(recovered)
                    persist(recovered)
                    ControllerOutcome(stateToNotify = recovered)
                }

                else -> ControllerOutcome(stateToNotify = current)
            }
        }
        deliver(outcome)
    }

    fun dispatch(event: UpdateEvent) {
        val outcome = synchronized(lock) { applyEventLocked(event) }
        deliver(outcome)
    }

    fun installerReturned() {
        val outcome = synchronized(lock) {
            val current = machine.state
            if (current !is UpdateState.LaunchRequested) return
            activeEffectToken = null
            val ready = UpdateState.InstallerReady(current.artifact)
            machine.restore(ready)
            persist(ready)
            ControllerOutcome(stateToNotify = ready)
        }
        deliver(outcome)
    }

    private fun applyEventLocked(event: UpdateEvent): ControllerOutcome {
        val previous = machine.state
        val transition = machine.dispatch(event)
        val changed = transition.state !== previous
        if (changed) persist(transition.state)
        val work = transition.effect?.let(::launchEffectLocked)?.work
        return ControllerOutcome(
            stateToNotify = transition.state.takeIf { changed },
            work = work,
        )
    }

    private fun launchEffectLocked(effect: UpdateEffect): ControllerOutcome {
        val token = ++nextEffectToken
        activeEffectToken = token
        return ControllerOutcome(work = EffectWork(token, effect))
    }

    private fun deliver(outcome: ControllerOutcome) {
        outcome.stateToNotify?.let(onStateChanged)
        outcome.work?.let(::runEffect)
    }

    private fun runEffect(work: EffectWork) {
        try {
            effectRunner.run(work.effect) { event -> acceptEffectEvent(work, event) }
        } catch (failure: Throwable) {
            acceptEffectEvent(
                work,
                UpdateEvent.Failed(work.effect.stage, failure.message ?: "Update operation failed"),
            )
        }
    }

    private fun acceptEffectEvent(work: EffectWork, event: UpdateEvent) {
        val outcome = synchronized(lock) {
            if (activeEffectToken != work.token) return
            if (event.isTerminalFor(work.effect)) activeEffectToken = null
            applyEventLocked(event)
        }
        deliver(outcome)
    }

    private fun loadState(): UpdateState = try {
        persistence.load() ?: UpdateState.Idle
    } catch (failure: Throwable) {
        onPersistenceFailure(failure)
        UpdateState.Idle
    }

    private fun persist(state: UpdateState) {
        try {
            persistence.save(state)
        } catch (failure: Throwable) {
            onPersistenceFailure(failure)
        }
    }

    private data class EffectWork(
        val token: Long,
        val effect: UpdateEffect,
    )

    private data class ControllerOutcome(
        val stateToNotify: UpdateState? = null,
        val work: EffectWork? = null,
    )
}

private val UpdateEffect.stage: UpdateStage
    get() = when (this) {
        UpdateEffect.FetchReleases -> UpdateStage.DISCOVERY
        is UpdateEffect.StartDownload,
        UpdateEffect.CancelDownload,
        -> UpdateStage.DOWNLOAD

        is UpdateEffect.VerifyDownload -> UpdateStage.VERIFICATION
        UpdateEffect.CheckInstallPermission,
        UpdateEffect.OpenUnknownSourcesSettings,
        is UpdateEffect.LaunchInstaller,
        -> UpdateStage.INSTALLER
    }

private fun UpdateEvent.isTerminalFor(effect: UpdateEffect): Boolean = when (effect) {
    UpdateEffect.FetchReleases -> this is UpdateEvent.ReleasesLoaded || this is UpdateEvent.Failed
    is UpdateEffect.StartDownload ->
        this is UpdateEvent.DownloadCompleted || this is UpdateEvent.DownloadCancelled || this is UpdateEvent.Failed

    UpdateEffect.CancelDownload -> this is UpdateEvent.DownloadCancelled || this is UpdateEvent.Failed
    is UpdateEffect.VerifyDownload -> this is UpdateEvent.VerificationSucceeded || this is UpdateEvent.Failed
    UpdateEffect.CheckInstallPermission -> this is UpdateEvent.InstallPermissionChecked || this is UpdateEvent.Failed
    UpdateEffect.OpenUnknownSourcesSettings -> this is UpdateEvent.Failed
    is UpdateEffect.LaunchInstaller -> this is UpdateEvent.Failed
}
