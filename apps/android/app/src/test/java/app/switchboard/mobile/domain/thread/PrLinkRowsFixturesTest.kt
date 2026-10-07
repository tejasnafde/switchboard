package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs tests/fixtures/pr-link-rows.json, the vectors tests/unit/pull-request-links.test.ts checks. */
class PrLinkRowsFixturesTest {
    @Test
    fun everyFixtureCaseMatchesTheSharedRule() {
        val cases = (loadFixture() as JsonArray).values.map { it as JsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val id = case.str("id")
            val link = decodeLink(case.values.getValue("link") as JsonObject)
            assertEquals(id, case.str("text"), PrLinkRows.text(link))
            assertEquals(id, case.str("unlinkLabel"), PrLinkRows.unlinkLabel(link.ref))
        }
    }

    private fun decodeLink(raw: JsonObject): PrLink {
        val ref = raw.values.getValue("ref") as JsonObject
        return PrLink(
            ref = PrLinkRef(
                host = ref.str("host"),
                owner = ref.str("owner"),
                name = ref.str("name"),
                number = (ref.values.getValue("number") as JsonNumber).source.toLong(),
            ),
            source = raw.str("source"),
            linkedAt = 0,
            state = (raw.values["state"] as? JsonString)?.value,
        )
    }

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/pr-link-rows.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/pr-link-rows.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
