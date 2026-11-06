package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteBridgeOriginDecoderTest {
    @Test
    fun `a bridge chat carries its marker and stop state`() {
        assertEquals(BridgeOrigin.Marker(null), session("bridgeOrigin" to obj("stop" to JsonNull)).bridgeOrigin)
        assertEquals(BridgeOrigin.Marker(null), session("bridgeOrigin" to obj()).bridgeOrigin)
        assertEquals(
            BridgeOrigin.Marker(BridgeOrigin.Stop.Pending),
            session("bridgeOrigin" to obj("stop" to JsonString("pending"))).bridgeOrigin,
        )
        assertEquals(
            BridgeOrigin.Marker(BridgeOrigin.Stop.Stopped),
            session("bridgeOrigin" to obj("stop" to JsonString("stopped"))).bridgeOrigin,
        )
        assertEquals(
            BridgeOrigin.Marker(BridgeOrigin.Stop.Unconfirmed),
            session("bridgeOrigin" to obj("stop" to JsonString("unconfirmed"))).bridgeOrigin,
        )
    }

    @Test
    fun `a chat from an older backend or another chat has no marker`() {
        assertNull(session().bridgeOrigin)
        assertNull(session("bridgeOrigin" to JsonNull).bridgeOrigin)
    }

    @Test
    fun `a marker it cannot read is dropped, not guessed`() {
        assertNull(session("bridgeOrigin" to JsonString("yes")).bridgeOrigin)
        assertNull(session("bridgeOrigin" to obj("stop" to JsonString("gone"))).bridgeOrigin)
        assertNull(session("bridgeOrigin" to obj("stop" to JsonNumber("1"))).bridgeOrigin)
    }

    @Test
    fun `the labels match the desktop's`() {
        assertEquals("From the bridge", BridgeOrigin.label(BridgeOrigin.Marker(null)))
        assertEquals("Bridge stop pending", BridgeOrigin.label(BridgeOrigin.Marker(BridgeOrigin.Stop.Pending)))
        assertEquals("Bridge stopped", BridgeOrigin.label(BridgeOrigin.Marker(BridgeOrigin.Stop.Stopped)))
        assertEquals(
            "Bridge stop not confirmed",
            BridgeOrigin.label(BridgeOrigin.Marker(BridgeOrigin.Stop.Unconfirmed)),
        )
    }

    private fun session(vararg fields: Pair<String, JsonValue>): SessionSummary = RemoteDecoders.projects(
        JsonArray(
            listOf(
                obj(
                    "path" to JsonString("/repo"),
                    "name" to JsonString("repo"),
                    "sessions" to JsonArray(
                        listOf(
                            obj(
                                "id" to JsonString("thread-1"),
                                "source" to JsonString("claude-code"),
                                "title" to JsonString("Task"),
                                "startedAt" to JsonNumber("42"),
                                "messageCount" to JsonNumber("3"),
                                "filePath" to JsonString(""),
                                *fields,
                            ),
                        ),
                    ),
                    "workspaceId" to JsonNull,
                ),
            ),
        ),
    ).single().sessions.single()

    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))
}
