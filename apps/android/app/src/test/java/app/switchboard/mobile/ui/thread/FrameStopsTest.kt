package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameStopsTest {
    @Test
    fun countsTheFirstStopOnly() {
        val seen = mutableListOf<LiveStop>()
        val stops = FrameStops { seen += it }
        stops.stop(LiveStop.WATCHDOG)
        stops.stop(LiveStop.CRASHED)
        assertEquals(listOf(LiveStop.WATCHDOG), seen)
    }

    @Test
    fun aReleasedFrameStopsNothing() {
        val seen = mutableListOf<LiveStop>()
        val stops = FrameStops { seen += it }
        stops.release()
        stops.stop(LiveStop.RELOAD)
        assertEquals(emptyList<LiveStop>(), seen)
    }
}
