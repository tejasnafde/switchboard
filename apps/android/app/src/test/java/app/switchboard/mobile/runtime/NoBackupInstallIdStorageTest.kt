package app.switchboard.mobile.runtime

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class NoBackupInstallIdStorageTest {
    private val directory: File = Files.createTempDirectory("sb-install-id").toFile()

    @After
    fun cleanUp() {
        directory.deleteRecursively()
    }

    @Test
    fun `mints the install id once and reads it back in a later launch`() {
        var minted = 0
        val first = StableDeviceIdentityProvider(
            NoBackupInstallIdStorage(directory),
            idSource = { "0b6f3a4e-1c2d-4e5f-8a9b-00000000000${++minted}" },
        ).get().deviceId
        val later = StableDeviceIdentityProvider(
            NoBackupInstallIdStorage(directory),
            idSource = { error("a stored id must not be minted again") },
        ).get().deviceId

        assertEquals("0b6f3a4e-1c2d-4e5f-8a9b-000000000001", first)
        assertEquals(first, later)
        assertEquals(1, minted)
        assertFalse(File(directory, "switchboard-install-id.tmp").exists())
    }
}
