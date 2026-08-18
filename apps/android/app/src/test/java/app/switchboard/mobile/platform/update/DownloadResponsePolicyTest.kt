package app.switchboard.mobile.platform.update

import org.junit.Assert.assertEquals
import org.junit.Test

class DownloadResponsePolicyTest {
    @Test
    fun partialContentAppendsWhileAFullResponseRestartsThePartFile() {
        assertEquals(
            DownloadResponsePlan(append = true, startingBytes = 40, totalBytes = 100),
            DownloadResponsePolicy.plan(
                statusCode = 206,
                existingBytes = 40,
                contentLength = 60,
                contentRange = "bytes 40-99/100",
            ),
        )
        assertEquals(
            DownloadResponsePlan(append = false, startingBytes = 0, totalBytes = 100),
            DownloadResponsePolicy.plan(
                statusCode = 200,
                existingBytes = 40,
                contentLength = 100,
                contentRange = null,
            ),
        )
    }

    @Test(expected = IllegalStateException::class)
    fun rejectsNonSuccessfulDownloadResponses() {
        DownloadResponsePolicy.plan(404, 0, 0, null)
    }
}
