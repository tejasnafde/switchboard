package app.switchboard.mobile.platform.push

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ExpoInstallationIdentityTest {
    @Test
    fun `existing Expo notifications installation id survives native upgrade`() {
        val root = Files.createTempDirectory("expo-installation").toFile()
        root.resolve(ExpoInstallationIdentity.PRIMARY_FILE_NAME)
            .writeText("A0B1C2D3-0000-4000-8000-000000000000\n")

        val identity = ExpoInstallationIdentity(
            noBackupDirectory = root,
            legacyPreference = { error("primary id should win") },
            newUuid = { error("existing id should win") },
        )

        assertEquals("a0b1c2d3-0000-4000-8000-000000000000", identity.getOrCreate())
    }

    @Test
    fun `legacy Expo preference migrates before legacy file and new uuid`() {
        val root = Files.createTempDirectory("expo-installation").toFile()
        root.resolve(ExpoInstallationIdentity.LEGACY_FILE_NAME)
            .writeText("11111111-1111-4111-8111-111111111111")
        val identity = ExpoInstallationIdentity(
            noBackupDirectory = root,
            legacyPreference = { "22222222-2222-4222-8222-222222222222" },
            newUuid = { "33333333-3333-4333-8333-333333333333" },
        )

        assertEquals("22222222-2222-4222-8222-222222222222", identity.getOrCreate())
        assertEquals(
            "22222222-2222-4222-8222-222222222222",
            root.resolve(ExpoInstallationIdentity.PRIMARY_FILE_NAME).readText(),
        )
    }

    @Test
    fun `invalid stored values create and persist one lowercase uuid`() {
        val root = Files.createTempDirectory("expo-installation").toFile()
        root.resolve(ExpoInstallationIdentity.PRIMARY_FILE_NAME).writeText("not-a-uuid")
        var generated = 0
        val identity = ExpoInstallationIdentity(
            noBackupDirectory = root,
            legacyPreference = { null },
            newUuid = {
                generated += 1
                "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
            },
        )

        assertEquals("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identity.getOrCreate())
        assertEquals("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identity.getOrCreate())
        assertEquals(1, generated)
        assertTrue(root.resolve(ExpoInstallationIdentity.PRIMARY_FILE_NAME).isFile)
    }
}
