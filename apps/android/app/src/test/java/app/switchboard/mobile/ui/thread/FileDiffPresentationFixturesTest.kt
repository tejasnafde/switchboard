package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs tests/fixtures/compact-file-diff.json, the vectors tests/unit/compact-file-diff.test.ts checks. */
class FileDiffPresentationFixturesTest {
    @Test
    fun everyFixtureCaseMatchesTheSharedRule() {
        val cases = (loadFixture() as JsonArray).values.map { it as JsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val id = case.str("id")
            val expected = case.values.getValue("expected") as JsonObject
            val diff = FileDiffPresenter.present(case.str("oldContent"), case.str("newContent"))
            assertEquals(id, expected.int("addedLines"), diff.addedLines)
            assertEquals(id, expected.int("removedLines"), diff.removedLines)
            assertEquals(id, expected.bool("truncated"), diff.truncated)
            assertEquals(id, expected.bool("countsExact"), diff.countsExact)
            assertEquals(id, (expected.values.getValue("lines") as JsonArray).values.map { decodeLine(it as JsonObject) }, diff.lines)
        }
    }

    private fun decodeLine(raw: JsonObject) = CompactDiffLine(
        kind = when (raw.str("kind")) {
            "context" -> DiffLineKind.Context
            "added" -> DiffLineKind.Added
            "removed" -> DiffLineKind.Removed
            else -> DiffLineKind.Omitted
        },
        text = raw.str("text"),
        oldLine = (raw.values["oldLine"] as? JsonNumber)?.source?.toInt(),
        newLine = (raw.values["newLine"] as? JsonNumber)?.source?.toInt(),
    )

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value

    private fun JsonObject.int(key: String) = (values.getValue(key) as JsonNumber).source.toInt()

    private fun JsonObject.bool(key: String) = (values.getValue(key) as JsonBoolean).value

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/compact-file-diff.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/compact-file-diff.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
