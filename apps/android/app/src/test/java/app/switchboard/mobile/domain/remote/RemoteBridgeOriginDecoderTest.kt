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

    @Test
    fun `a bridge chat carries the measured check summary`() {
        assertEquals(
            BridgeOrigin.Marker(null, BridgeOrigin.CheckSummary(BridgeOrigin.EvidenceStatus.Measured, 2, 0)),
            session(
                "bridgeOrigin" to obj(
                    "stop" to JsonNull,
                    "checks" to checks("measured", "2", "0"),
                ),
            ).bridgeOrigin,
        )
        assertEquals(
            BridgeOrigin.Marker(
                BridgeOrigin.Stop.Stopped,
                BridgeOrigin.CheckSummary(BridgeOrigin.EvidenceStatus.Stale, 1, 0),
            ),
            session(
                "bridgeOrigin" to obj(
                    "stop" to JsonString("stopped"),
                    "checks" to checks("stale", "1", "0"),
                ),
            ).bridgeOrigin,
        )
    }

    @Test
    fun `a check summary it cannot read is dropped and the marker stands`() {
        for (bad in listOf(
            checks("green", "1", "0"),
            checks("measured", "-1", "0"),
            checks("measured", "1.5", "0"),
            obj("status" to JsonString("measured"), "passed" to JsonNumber("1")),
            JsonString("measured"),
        )) {
            assertEquals(
                BridgeOrigin.Marker(null),
                session("bridgeOrigin" to obj("stop" to JsonNull, "checks" to bad)).bridgeOrigin,
            )
        }
    }

    @Test
    fun `the check labels match the desktop's`() {
        fun label(status: BridgeOrigin.EvidenceStatus, passed: Int, failed: Int) =
            BridgeOrigin.checksLabel(BridgeOrigin.CheckSummary(status, passed, failed))
        assertEquals("1 check passed", label(BridgeOrigin.EvidenceStatus.Measured, 1, 0))
        assertEquals("2 checks passed", label(BridgeOrigin.EvidenceStatus.Measured, 2, 0))
        assertEquals("1 check failed", label(BridgeOrigin.EvidenceStatus.Measured, 1, 1))
        assertEquals("Checks measured on older code", label(BridgeOrigin.EvidenceStatus.Stale, 1, 0))
        assertEquals("Checks could not run", label(BridgeOrigin.EvidenceStatus.Unavailable, 0, 0))
        assertEquals("Checks not measured", label(BridgeOrigin.EvidenceStatus.NotMeasured, 0, 0))
    }

    private fun checks(status: String, passed: String, failed: String) = obj(
        "status" to JsonString(status),
        "passed" to JsonNumber(passed),
        "failed" to JsonNumber(failed),
    )

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
