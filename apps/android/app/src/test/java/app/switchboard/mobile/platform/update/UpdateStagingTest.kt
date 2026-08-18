package app.switchboard.mobile.platform.update

import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Test

class UpdateStagingTest {
    @Test
    fun discardsARejectedStagedArtifact() {
        val staged = Files.createTempFile("switchboard-rejected", ".apk.part").toFile()

        UpdateStaging.discard(staged)

        assertFalse(staged.exists())
    }
}
