package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Test

class MessagePillMetadataTest {
    @Test
    fun `decoder retains only bounded presentation metadata`() {
        val values = linkedMapOf<String, JsonValue>()
        values["invalid kind"] = pill("Invalid id", "file")
        values["bad-kind"] = pill("Bad kind", "other")
        values["blank"] = pill("   ", "terminal")
        values["too-long"] = pill("x".repeat(121), "chat-message")
        values["wrong-shape"] = JsonNumber("1")
        repeat(40) { index ->
            values["pill-$index"] = pill("Label $index", "file")
        }

        val decoded = decodeMessagePills(JsonObject(values))

        assertEquals(32, decoded.size)
        assertEquals(MessagePill("Label 0", "file"), decoded["pill-0"])
        assertEquals("pill-31", decoded.keys.last())
    }

    private fun pill(label: String, kind: String) = JsonObject(
        linkedMapOf(
            "label" to JsonString(label),
            "kind" to JsonString(kind),
        ),
    )
}
