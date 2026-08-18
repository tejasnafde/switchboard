package app.switchboard.mobile.data.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadSyncPolicyTest {
    @Test
    fun successfulCommandRemainsSuccessfulWhenFollowUpSyncFails() {
        val result = ThreadSyncPolicy.afterCommand(
            ThreadOperationResult.Success("renamed"),
        ) { ThreadOperationResult.Failure("refresh offline") }

        assertEquals("renamed", (result.command as ThreadOperationResult.Success).value)
        assertTrue(result.followUp is ThreadOperationResult.Failure)
    }

    @Test
    fun failedCommandDoesNotRunOrReportAFollowUp() {
        var refreshes = 0
        val result = ThreadSyncPolicy.afterCommand<String, String>(
            ThreadOperationResult.Failure("rename failed"),
        ) {
            refreshes++
            ThreadOperationResult.Success("unused")
        }

        assertEquals(0, refreshes)
        assertNull(result.followUp)
    }
}
