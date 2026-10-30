package app.switchboard.mobile.ui.thread

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The live page libraries ship as assets at their /_sb/ paths, the vendored bytes, with their licences. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveLibraryAssetsTest {
    private val vendored = File("../../../resources/sb-live")

    @Test
    fun shipsEachLibraryAndLicence() {
        val assets = ApplicationProvider.getApplicationContext<Context>().assets
        for (path in listOf(
            "chart.js",
            "d3.js",
            "three.js",
            "three/addons/controls/OrbitControls.js",
            "licenses/chart.js-LICENSE.md",
            "licenses/d3-LICENSE",
            "licenses/three-LICENSE",
        )) {
            assertArrayEquals(path, File(vendored, path).readBytes(), assets.open(path).use { it.readBytes() })
        }
    }
}
