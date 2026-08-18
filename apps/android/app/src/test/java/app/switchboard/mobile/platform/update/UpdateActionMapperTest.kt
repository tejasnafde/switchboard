package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdateEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateActionMapperTest {
    @Test
    fun mapsEveryVisibleActionToItsAbsoluteStateMachineEvent() {
        assertEquals(UpdateEvent.CheckRequested, UpdateActionMapper.eventFor(UpdateAction.CHECK))
        assertEquals(UpdateEvent.DownloadRequested, UpdateActionMapper.eventFor(UpdateAction.DOWNLOAD))
        assertEquals(UpdateEvent.CancelRequested, UpdateActionMapper.eventFor(UpdateAction.CANCEL))
        assertEquals(UpdateEvent.InstallRequested, UpdateActionMapper.eventFor(UpdateAction.INSTALL))
        assertEquals(
            UpdateEvent.OpenPermissionSettingsRequested,
            UpdateActionMapper.eventFor(UpdateAction.OPEN_SETTINGS),
        )
        assertEquals(UpdateEvent.RetryRequested, UpdateActionMapper.eventFor(UpdateAction.RETRY))
    }
}
