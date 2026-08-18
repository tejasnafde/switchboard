package app.switchboard.mobile.platform.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateRuntimeStartupTest {
    @Test
    fun startsAndInspectsPendingInstallationExactlyOnceForProductionIdentity() {
        var inspections = 0
        var starts = 0
        val startup = UpdateRuntimeStartup(
            identity = UpdateRuntimeIdentity(
                packageName = ArchivePreflightPolicy.PRODUCTION_PACKAGE,
                debuggable = false,
            ),
            inspectPendingInstallation = { inspections++ },
            startController = { starts++ },
        )

        startup.start()
        startup.start()

        assertTrue(startup.enabled)
        assertEquals(1, inspections)
        assertEquals(1, starts)
    }

    @Test
    fun debugOrNonCanonicalBuildsNeverStartTheUpdater() {
        listOf(
            UpdateRuntimeIdentity(ArchivePreflightPolicy.PRODUCTION_PACKAGE, debuggable = true),
            UpdateRuntimeIdentity("app.switchboard.mobile.native.dev", debuggable = false),
        ).forEach { identity ->
            var starts = 0
            val startup = UpdateRuntimeStartup(identity, {}, { starts++ })

            startup.start()

            assertFalse(startup.enabled)
            assertEquals(0, starts)
        }
    }
}
