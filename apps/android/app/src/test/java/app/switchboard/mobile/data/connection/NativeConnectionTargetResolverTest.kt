package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.iap.IapTarget
import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import app.switchboard.mobile.platform.protocol.LineEndpoint
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

    @Test
    fun `valid IAP row resolves a distinct target with its migrated backend token`() {
        val database = FakeDatabase(
            mapOf(
                "iap" to StoredConnection(
                    connection = ConnectionEntity(
                        id = "iap",
                        label = "work VM",
                        kind = "iap",
                        url = null,
                        project = "project-1",
                        zone = "asia-south1-b",
                        instance = "work-vm",
                        port = 8766,
                    ),
                    activeCredentialKey = "ref-iap",
                ),
            ),
        )
        val credentials = FakeCredentials(
            mapOf(
                "ref-iap" to NativeCredential(
                    NativeCredential.Kind.LEGACY_INLINE_TOKEN,
                    "backend-secret",
                ),
            ),
        )

        val result = NativeConnectionTargetResolver(database, credentials)
            .resolve("iap", "phone", "Pixel") as ConnectionTargetResolution.Ready

        assertEquals(
            LineEndpoint.CloudIap(IapTarget("project-1", "asia-south1-b", "work-vm", 8766)),
            result.target.endpoint,
        )
        assertEquals(Credential.LegacySharedToken("backend-secret"), result.target.credential)
        assertEquals("ref-iap", result.target.credentialRef)
    }

    @Test
    fun `IAP rejects incomplete topology invalid ports and non-backend credentials`() {
        val rows = mapOf(
            "missing" to iapStored("missing", project = ""),
            "port" to iapStored("port", port = 70_000),
            "session" to iapStored("session"),
        )
        val credentials = FakeCredentials(
            mapOf(
                "ref-missing" to NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, "secret"),
                "ref-port" to NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, "secret"),
                "ref-session" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "secret"),
            ),
        )
        val resolver = NativeConnectionTargetResolver(FakeDatabase(rows), credentials)

        listOf("missing", "port", "session").forEach { id ->
            assertTrue(resolver.resolve(id, "phone", "Pixel") is ConnectionTargetResolution.Failure)
        }
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

    private fun iapStored(
        id: String,
        project: String = "project",
        port: Int = 8766,
    ) = StoredConnection(
        connection = ConnectionEntity(
            id = id,
            label = id,
            kind = "iap",
            url = null,
            project = project,
            zone = "zone",
            instance = "instance",
            port = port,
        ),
        activeCredentialKey = "ref-$id",
    )
}
