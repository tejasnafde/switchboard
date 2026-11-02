package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ChatVisualShareTargetTest {
    private val mounted = Any()

    @Test
    fun aViewThatDrewItsOwnPageIsShared() {
        assertSame(mounted, visualShareTarget(null, showSource = false, drawn = true, mounted = mounted, drawnView = mounted))
    }

    @Test
    fun aCachedHeightAloneDoesNotShare() {
        assertNull(visualShareTarget(null, showSource = false, drawn = true, mounted = mounted, drawnView = null))
    }

    @Test
    fun anOlderViewThatDrewDoesNotShareTheNewOne() {
        assertNull(visualShareTarget(null, showSource = false, drawn = true, mounted = mounted, drawnView = Any()))
    }

    @Test
    fun noShareForAnErrorTheSourceOrNoView() {
        assertNull(visualShareTarget("bad", showSource = false, drawn = true, mounted = mounted, drawnView = mounted))
        assertNull(visualShareTarget(null, showSource = true, drawn = true, mounted = mounted, drawnView = mounted))
        assertNull(visualShareTarget(null, showSource = false, drawn = false, mounted = mounted, drawnView = mounted))
        assertNull(visualShareTarget<Any>(null, showSource = false, drawn = true, mounted = null, drawnView = null))
    }
}
