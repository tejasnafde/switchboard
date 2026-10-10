package app.switchboard.mobile.domain.remote

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

/** Runs tests/fixtures/chat-search-cases.json, the cases tests/unit/chat-search.test.ts checks. */
class ChatSearchFixturesTest {
    @Test
    fun everyFixtureCaseMatchesTheSharedRule() {
        val fixture = loadFixture() as JsonObject
        val chats = (fixture.values.getValue("chats") as JsonArray).values.map { it as JsonObject }
        val cases = (fixture.values.getValue("cases") as JsonArray).values.map { it as JsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val ranked = ChatSearch.rank(chats, case.str("query")) { chat ->
                ChatSearch.Item(
                    title = chat.str("title"),
                    projectName = chat.str("projectName"),
                    lastActivity = (chat.values.getValue("lastActivity") as JsonNumber).source.toLong(),
                    archived = (chat.values["archived"] as JsonBoolean?)?.value ?: false,
                )
            }
            val expected = (case.values.getValue("expected") as JsonArray).values.map { (it as JsonString).value }
            assertEquals(case.str("id"), expected, ranked.map { it.str("id") })
        }
    }

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/chat-search-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/chat-search-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
