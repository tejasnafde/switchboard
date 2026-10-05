package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs tests/fixtures/system-marker-cases.json, the vectors tests/unit/system-markers.test.ts checks. */
class SystemMarkersFixturesTest {
    @Test
    fun everyFixtureCaseMatchesTheSharedRule() {
        val cases = (loadFixture() as JsonArray).values.map { it as JsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val id = case.str("id")
            assertEquals(id, expected(case.values.getValue("expected") as JsonObject), SystemMarkers.view(case.str("content")))
        }
    }

    @Test
    fun aLiveEventMarkerReadsBack() {
        val row = PeerUndelivered("agent_2", "Docs \"x\"", "link-removed", "line 1\nline 2", sent = true)
        assertEquals(SystemRowView.Undelivered(row), SystemMarkers.view(SystemMarkers.undeliveredMarker(row)))
    }

    private fun expected(value: JsonObject): SystemRowView = when (value.str("kind")) {
        "peer-undelivered" -> {
            val row = value.values.getValue("row") as JsonObject
            SystemRowView.Undelivered(
                PeerUndelivered(
                    row.str("to"), row.str("toLabel"), row.str("reason"), row.str("text"),
                    (row.values.getValue("sent") as JsonBoolean).value,
                ),
            )
        }
        "error" -> SystemRowView.Error(value.str("message"))
        else -> SystemRowView.Notice(value.str("title"), value.str("body"))
    }

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/system-marker-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/system-marker-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
