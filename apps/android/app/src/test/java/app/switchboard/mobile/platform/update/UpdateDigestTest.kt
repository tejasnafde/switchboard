package app.switchboard.mobile.platform.update

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateDigestTest {
    @Test
    fun computesLowercaseSha256() {
        val file = File.createTempFile("switchboard-update", ".part")
        try {
            file.writeText("switchboard")
            assertEquals(
                "487537935c922e003caf22a9e8b0108e8b13ff4b350a2a2e83e290c48314cd3c",
                UpdateDigest.sha256(file),
            )
        } finally {
            file.delete()
        }
    }
}
