package app.switchboard.mobile.compat

import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyStateDecoderTest {
    @Test
    fun bothAsyncStorageLayoutsDecodeToTheSameLegacyRows() {
        val rk = LegacyAsyncStorageDecoder.decode(fixture("async-storage/rkstorage.json"))
        val next = LegacyAsyncStorageDecoder.decode(fixture("async-storage/asyncstorage.json"))

        assertEquals(LegacyStorageLayout("RKStorage", "catalystLocalStorage"), rk.layout)
        assertEquals(LegacyStorageLayout("AsyncStorage", "Storage"), next.layout)
        assertEquals(rk.rows, next.rows)
        assertEquals(
            listOf(
                "sb-chat-cache",
                "sb-connections",
                "sb-outbox:turn-image-only",
                "sb-outbox:turn-text",
                "switchboard-prefs",
            ),
            rk.rows.keys.toList(),
        )
    }

    @Test
    fun fixtureRowsMapConnectionsPreferencesCacheAndOutboxWithoutLosingIdentity() {
        val rows = LegacyAsyncStorageDecoder.decode(fixture("async-storage/rkstorage.json")).rows
        val decoded = LegacyStateDecoder.decode(rows)

        assertTrue(decoded.blockingIssues.isEmpty())
        assertTrue(decoded.quarantinedIssues.isEmpty())
        assertEquals(3, decoded.connections.size)
        assertEquals(
            LegacyConnection.Ws(
                id = "legacy-lan",
                label = "Legacy Mac",
                url = "wss://legacy.example.test/switchboard",
                inlineToken = "fixture-legacy-shared-token",
            ),
            decoded.connections.single { it.id == "legacy-lan" },
        )
        assertEquals(
            LegacyConnection.Iap(
                id = "work-iap",
                label = "Work VM",
                project = "work-project",
                zone = "asia-south1-b",
                instance = "dev-vm",
                port = 8766,
                inlineToken = null,
            ),
            decoded.connections.single { it.id == "work-iap" },
        )

        val preferences = decoded.preferences
        assertTrue(preferences.defaultMode is LegacyPreference.Persisted)
        assertEquals("accept-edits", preferences.defaultMode.value)
        assertEquals("Review café 🚀", preferences.threads.getValue("lan-main:thread-same").draft)
        assertEquals(listOf("workspace-ops", "ungrouped"), preferences.collapsedWorkspaces)

        assertEquals(2, decoded.cachedThreads.size)
        val cached = decoded.cachedThreads.getValue("work-iap:thread-same")
        assertEquals(2, cached.unread)
        assertEquals("turn-image-only", cached.items.first().id)
        assertEquals(listOf("data:image/png;base64,iVBORw0KGgo="), cached.items.first().images)

        assertEquals(listOf("turn-text", "turn-image-only"), decoded.outbox.map { it.messageId })
        val imageOnly = decoded.outbox.single { it.messageId == "turn-image-only" }
        assertEquals("", imageOnly.text)
        assertEquals(0, imageOnly.attempts)
        assertEquals(
            listOf(LegacyOutboxImage("data:image/png;base64,iVBORw0KGgo=", "image/png")),
            imageOnly.images,
        )
    }

    @Test
    fun aPartialConnectionIsBlockingAndIsNeverCollapsedIntoAnEmptyAccount() {
        val decoded = LegacyStateDecoder.decode(
            mapOf(
                "sb-connections" to
                    """{"state":{"configs":[{"id":"ok","label":"Mac","kind":"ws","url":"ws://host"},{"id":"broken","label":"VM","kind":"iap","project":"p"}]},"version":0}""",
            ),
        )

        assertEquals(listOf("ok"), decoded.connections.map { it.id })
        assertTrue(decoded.blockingIssues.any { it.code == "partial_connection" && it.recordId == "broken" })
        assertFalse(decoded.canMigrate)
    }

    @Test
    fun anUnreadableOrMismatchedOutboxRecordIsBlockingAndRetainsItsSourceKey() {
        val decoded = LegacyStateDecoder.decode(
            mapOf(
                "sb-outbox:expected-id" to
                    """{"connectionId":"c","threadId":"t","messageId":"other-id","text":"owed","createdAt":1,"attempts":0}""",
                "sb-outbox:corrupt" to "{not-json",
            ),
        )

        assertTrue(decoded.blockingIssues.any { it.sourceKey == "sb-outbox:expected-id" && it.code == "outbox_id_mismatch" })
        assertTrue(decoded.blockingIssues.any { it.sourceKey == "sb-outbox:corrupt" && it.code == "invalid_json" })
        assertFalse(decoded.canMigrate)
    }

    @Test
    fun corruptChatCacheIsQuarantinedWithoutDiscardingValidConnections() {
        val decoded = LegacyStateDecoder.decode(
            mapOf(
                "sb-connections" to fixture("zustand/connections.json"),
                "sb-chat-cache" to "[]",
            ),
        )

        assertEquals(3, decoded.connections.size)
        assertTrue(decoded.blockingIssues.isEmpty())
        assertTrue(decoded.quarantinedIssues.any { it.sourceKey == "sb-chat-cache" && it.code == "invalid_shape" })
        assertTrue(decoded.cachedThreads.isEmpty())
        assertTrue(decoded.canMigrate)
    }

    @Test
    fun missingDefaultModeUsesATransientFallbackThatIsNotAStoredPreference() {
        val decoded = LegacyStateDecoder.decode(
            mapOf(
                "switchboard-prefs" to
                    """{"state":{"threads":{},"collapsedWorkspaces":[]},"version":0}""",
            ),
        )

        assertEquals(LegacyPreference.TransientFallback("sandbox"), decoded.preferences.defaultMode)
        assertNull(decoded.preferences.persistedDefaultMode)
    }

    @Test
    fun secureStoreNamesMatchTheCommittedFixtureIncludingUnsafeConnectionIds() {
        assertEquals("SecureStore", LegacySecureStoreKeys.SHARED_PREFERENCES)
        assertEquals("key_v1", LegacySecureStoreKeys.DEFAULT_KEYCHAIN_SERVICE)
        assertEquals("office_mac_01_prod", LegacySecureStoreKeys.safeConnectionId("office/mac 01:prod"))
        assertEquals("sb-token-office_mac_01_prod", LegacySecureStoreKeys.tokenKey("office/mac 01:prod"))
        assertEquals("sb-session-office_mac_01_prod", LegacySecureStoreKeys.sessionKey("office/mac 01:prod"))
        assertEquals(
            "key_v1-sb-token-office_mac_01_prod",
            LegacySecureStoreKeys.preferenceKey(LegacySecureStoreKeys.tokenKey("office/mac 01:prod")),
        )
        assertEquals(
            listOf(
                "sb.google.refresh_token",
                "sb.google.access_token",
                "sb.google.expires_at",
                "sb.google.email",
                "sb.google.client_id",
                "sb.google.client_secret",
            ),
            LegacySecureStoreKeys.GOOGLE_KEYS,
        )
    }

    private fun fixture(relative: String): String {
        val path = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .map { it.resolve("tests/fixtures/mobile-native").resolve(relative) }
            .firstOrNull(Files::exists)
            ?: error("Missing fixture $relative from ${Path.of("").toAbsolutePath()}")
        return String(Files.readAllBytes(path), Charsets.UTF_8)
    }
}
