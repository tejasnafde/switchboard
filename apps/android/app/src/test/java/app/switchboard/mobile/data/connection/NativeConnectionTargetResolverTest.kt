package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import app.switchboard.mobile.platform.storage.NativeCredential
import app.switchboard.mobile.protocol.Credential
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeConnectionTargetResolverTest {
    @Test
    fun resolvesTheActiveNativeReferenceIntoEachTransportAuthMode() {
        val database = FakeDatabase(
            stored = mapOf(
                "session" to stored("session", "ref-session"),
                "pairing" to stored("pairing", "ref-pairing"),
                "legacy" to stored("legacy", "ref-legacy"),
            ),
        )
        val credentials = FakeCredentials(
            mapOf(
                "ref-session" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "device-secret"),
                "ref-pairing" to NativeCredential(NativeCredential.Kind.PAIRING_TOKEN, "pair-secret"),
                "ref-legacy" to NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, "legacy-secret"),
            ),
        )
        val resolver = NativeConnectionTargetResolver(database, credentials)

        val session = resolver.resolve("session", deviceId = "phone", deviceLabel = "Pixel")
        val pairing = resolver.resolve("pairing", deviceId = "phone", deviceLabel = "Pixel")
        val legacy = resolver.resolve("legacy", deviceId = "phone", deviceLabel = "Pixel")

        assertEquals(Credential.Session("device-secret"), (session as ConnectionTargetResolution.Ready).target.credential)
        assertEquals(Credential.Pairing("pair-secret", "Pixel"), (pairing as ConnectionTargetResolution.Ready).target.credential)
        assertEquals(Credential.LegacySharedToken("legacy-secret"), (legacy as ConnectionTargetResolution.Ready).target.credential)
        assertEquals("ref-session", session.target.credentialRef)
        assertEquals("ref-pairing", pairing.target.credentialRef)
        assertEquals("ref-legacy", legacy.target.credentialRef)
        assertEquals(listOf("ref-session", "ref-pairing", "ref-legacy"), credentials.reads)
    }

    @Test
    fun neitherResolvedTargetsNorFailuresExposeSecretMaterial() {
        val secret = "never-print-this-token"
        val database = FakeDatabase(
            mapOf(
                "legacy" to stored(
                    "legacy",
                    "ref",
                    "wss://example.test/sessions%2Factive?workspace=one&token=url-secret#tail",
                ),
            ),
        )
        val credentials = FakeCredentials(
            mapOf("ref" to NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, secret)),
        )
        val ready = NativeConnectionTargetResolver(database, credentials)
            .resolve("legacy", "phone", "Pixel")

        assertFalse(ready.toString().contains(secret))
        val target = (ready as ConnectionTargetResolution.Ready).target
        assertEquals(
            "wss://example.test/sessions%2Factive?workspace=one#tail",
            target.url,
        )
        assertFalse(target.toString().contains(secret))
        assertFalse(target.toString().contains("url-secret"))
        assertFalse(target.toString().contains("ref"))

        val missing = NativeConnectionTargetResolver(database, FakeCredentials(emptyMap()))
            .resolve("legacy", "phone", "Pixel")
        assertTrue(missing is ConnectionTargetResolution.Failure)
        assertFalse(missing.toString().contains("ref"))
    }

    private class FakeDatabase(
        private val stored: Map<String, StoredConnection>,
    ) : ConnectionDatabase {
        override fun find(connectionId: String): StoredConnection? = stored[connectionId]
        override fun upsert(connection: ConnectionEntity, activeCredentialKey: String) = Unit
        override fun delete(connectionId: String): Boolean = false
        override fun snapshot(): OfflineSnapshot = error("unused")
    }

    private class FakeCredentials(
        private val credentials: Map<String, NativeCredential>,
    ) : ConnectionCredentialStore {
        val reads = mutableListOf<String>()

        override fun writeAndVerify(
            logicalKey: String,
            credential: SelectedCredential.Present,
        ): CredentialWriteVerification = error("unused")

        override fun read(logicalKey: String): NativeCredential? {
            reads += logicalKey
            return credentials[logicalKey]
        }

        override fun deleteNativeOwned(logicalKey: String): Boolean = error("unused")
    }

    private fun stored(
        id: String,
        ref: String,
        url: String = "wss://example.test/sessions/active?workspace=one",
    ) = StoredConnection(
        connection = ConnectionEntity(
            id = id,
            label = id,
            kind = "ws",
            url = url,
            project = null,
            zone = null,
            instance = null,
            port = null,
        ),
        activeCredentialKey = ref,
    )
}
