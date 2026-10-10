package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Checks the copied model catalogs against tests/fixtures/model-catalog.json,
 * which tests/unit/model-catalog-fixture.test.ts keeps equal to src/shared/models.ts.
 */
class NewSessionDecisionsCatalogFixtureTest {
    @Test
    fun everyCatalogMatchesTheSharedModels() {
        val fixture = loadFixture() as JsonObject
        NewSessionDecisions.providers.forEach { provider ->
            val expected = (fixture.values.getValue(provider.agentType) as JsonArray).values.map {
                val row = it as JsonObject
                listOf(row.str("id"), row.str("label"), row.str("tier"))
            }
            val actual = NewSessionDecisions.models(provider.kind).map { listOf(it.id, it.label, it.tier) }
            assertEquals(provider.agentType, expected, actual)
        }
    }

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/model-catalog.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/model-catalog.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
