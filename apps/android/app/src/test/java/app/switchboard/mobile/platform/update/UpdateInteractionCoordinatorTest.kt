package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateEvent
import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateState
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateInteractionCoordinatorTest {
    private val release = UpdateRelease("0.6.0", "https://example.test/update.apk", "abc123")

    @Test
    fun unknownSourceRecoveryRequiresAPauseAndRunsOnlyOnceOnReturn() {
        val events = mutableListOf<UpdateEvent>()
        val coordinator = UpdateInteractionCoordinator(
            state = { UpdateState.PermissionRequired(release, verifiedApk(release)) },
            dispatch = events::add,
            installerReturned = {},
        )

        coordinator.onAction(UpdateAction.OPEN_SETTINGS)
        coordinator.onActivityResumed()
        assertEquals(listOf(UpdateEvent.OpenPermissionSettingsRequested), events)

        coordinator.onActivityPaused()
        coordinator.onActivityResumed()
        coordinator.onActivityResumed()

        assertEquals(
            listOf(
                UpdateEvent.OpenPermissionSettingsRequested,
                UpdateEvent.PermissionSettingsReturned,
            ),
            events,
        )
    }

    @Test
    fun installerReturnNeverRelaunchesAndIsConsumedOnce() {
        var returns = 0
        val coordinator = UpdateInteractionCoordinator(
            state = { UpdateState.LaunchRequested(verifiedApk(release)) },
            dispatch = {},
            installerReturned = { returns++ },
        )
        coordinator.onStateChanged(UpdateState.LaunchRequested(verifiedApk(release)))

        coordinator.onActivityResumed()
        assertEquals(0, returns)
        coordinator.onActivityPaused()
        coordinator.onActivityResumed()
        coordinator.onActivityResumed()

        assertEquals(1, returns)
    }

    @Test
    fun installerStateCanArriveAfterTheActivityAlreadyPaused() {
        var returns = 0
        val coordinator = UpdateInteractionCoordinator(
            state = { UpdateState.LaunchRequested(verifiedApk(release)) },
            dispatch = {},
            installerReturned = { returns++ },
        )

        coordinator.onActivityPaused()
        coordinator.onStateChanged(UpdateState.LaunchRequested(verifiedApk(release)))
        coordinator.onActivityResumed()

        assertEquals(1, returns)
    }

    @Test
    fun restoredPermissionStateIsRecheckedOnceOnTheFirstResume() {
        val events = mutableListOf<UpdateEvent>()
        val coordinator = UpdateInteractionCoordinator(
            state = { UpdateState.PermissionRequired(release, verifiedApk(release)) },
            dispatch = events::add,
            installerReturned = {},
        )

        coordinator.onActivityResumed()
        coordinator.onActivityResumed()

        assertEquals(listOf(UpdateEvent.PermissionSettingsReturned), events)
    }
}
