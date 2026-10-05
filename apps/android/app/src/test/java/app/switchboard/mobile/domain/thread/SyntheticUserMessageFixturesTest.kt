package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs the vectors tests/unit/synthetic-user-message-fixtures.test.ts checks
 * against the TypeScript split, so both rule sets stay equal.
 */
class SyntheticUserMessageFixturesTest {
    @Test
    fun everyCaseMatchesTheKotlinSplit() {
        val cases = (loadFixture() as JsonArray).values.map { it as JsonObject }
        assertTrue("fixture must not be empty", cases.isNotEmpty())
        cases.forEach { case ->
            val id = (case.values.getValue("id") as JsonString).value
            val text = (case.values.getValue("text") as JsonString).value
            val split = SyntheticUserMessage.split(text)
            val expected = case.values.getValue("expected")
            if (expected is JsonNull) {
                assertEquals("$id: real message", null, split)
                return@forEach
            }
            expected as JsonObject
            val rows = (expected.values.getValue("rows") as JsonArray).values.map { row ->
                row as JsonObject
                Triple(
                    (row.values.getValue("label") as JsonString).value,
                    (row.values.getValue("tone") as JsonString).value,
                    (row.values["detail"] as? JsonString)?.value,
                )
            }
            val actual = split?.parts?.map { part ->
                Triple(
                    SyntheticUserMessage.label(part),
                    SyntheticUserMessage.tone(part).name.lowercase(),
                    SyntheticUserMessage.detail(part),
                )
            }
            assertEquals("$id: rows", rows, actual)
            assertEquals("$id: userText", (expected.values.getValue("userText") as JsonString).value, split?.userText)
        }
    }

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/synthetic-user-message-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/synthetic-user-message-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
