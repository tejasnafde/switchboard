package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs tests/fixtures/limit-resume-cases.json, the vectors tests/unit/limit-resume-rules.test.ts checks. */
class LimitResumeFixturesTest {
    private val fixture = loadFixture() as JsonObject

    @Test
    fun theRowTextMatchesTheSharedRule() {
        val cases = section("limitStateText")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val name = (case.values.getValue("name") as JsonString).value
            val input = case.values.getValue("input") as JsonObject
            val expected = case.values.getValue("expected") as JsonObject
            val state = LimitResume.decode(input.values.getValue("state"))
            val time = (input.values.getValue("time") as JsonString).value
            assertEquals(name, expected.stringOrNull("title"), LimitResume.text(state) { time })
            assertEquals(name, expected.stringOrNull("detail"), LimitResume.detail(state))
        }
    }

    /** Every state the backend's `limitState` answers decodes to the same kind. */
    @Test
    fun everyBackendStateDecodes() {
        section("limitState").forEach { case ->
            val expected = case.values.getValue("expected") as JsonObject
            val state = LimitResume.decode(expected)
            assertEquals(expected.stringOrNull("kind"), kind(state))
            if (state is LimitState.Armed) {
                assertEquals((expected.values.getValue("resetAt") as JsonNumber).source.toLong(), state.resetAt)
            }
        }
    }

    @Test
    fun anUnknownKindShowsNoRow() {
        assertEquals(LimitState.None, LimitResume.decode(JsonObject(linkedMapOf("kind" to JsonString("paused")))))
        assertEquals(LimitState.None, LimitResume.decode(JsonNull))
    }

    private fun kind(state: LimitState) = when (state) {
        LimitState.None -> "none"
        is LimitState.Armed -> "armed"
        LimitState.Disarmed -> "disarmed"
        LimitState.GaveUp -> "gave_up"
        LimitState.NoReset -> "no_reset"
    }

    private fun section(name: String) = (fixture.values.getValue(name) as JsonArray).values.map { it as JsonObject }

    private fun JsonObject.stringOrNull(key: String): String? = (values[key] as? JsonString)?.value

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/limit-resume-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/limit-resume-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
