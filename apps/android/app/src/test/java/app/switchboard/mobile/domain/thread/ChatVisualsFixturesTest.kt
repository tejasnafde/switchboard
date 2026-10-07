package app.switchboard.mobile.domain.thread

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

/** Runs the fixtures tests/unit/chat-visuals.test.ts checks: chart-spec-cases.json and visual-fence-cases.json. */
class ChatVisualsFixturesTest {
    @Test
    fun everyChartSpecCaseMatchesTheSharedValidator() {
        val cases = (loadFixture("chart-spec-cases.json") as JsonArray).values.map { it as JsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val expected = case.values.getValue("expected") as JsonObject
            val want = if ((expected.values.getValue("ok") as JsonBoolean).value) {
                ChartParse.Ok(spec(expected.values.getValue("spec") as JsonObject))
            } else {
                ChartParse.Invalid(expected.str("error"))
            }
            assertEquals(case.str("id"), want, ChatVisuals.parseChartSpec(case.str("source")))
        }
    }

    @Test
    fun everyFenceCaseMatchesTheSharedSplit() {
        val cases = (loadFixture("visual-fence-cases.json") as JsonArray).values.map { it as JsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val want = (case.values.getValue("expected") as JsonArray).values.map { segment ->
                segment as JsonObject
                when (val kind = segment.str("kind")) {
                    "markdown" -> MessageSegment.Markdown(segment.str("text"))
                    else -> MessageSegment.Visual(VisualKind.entries.first { it.wire == kind }, segment.str("source"))
                }
            }
            assertEquals(case.str("id"), want, ChatVisuals.splitVisualBlocks(case.str("markdown")))
        }
    }

    @Test
    fun copiedChartDataIsTabSeparated() {
        val parsed = ChatVisuals.parseChartSpec(
            """{"type":"bar","labels":["a","b"],"series":[{"name":"s","values":[1,2.5]}],"xTitle":"x"}""",
        ) as ChartParse.Ok
        assertEquals("x\ts\na\t1\nb\t2.5", ChatVisuals.chartDataText(parsed.spec))
    }

    private fun spec(value: JsonObject) = ChartSpec(
        type = value.str("type"),
        labels = (value.values.getValue("labels") as JsonArray).values.map { (it as JsonString).value },
        series = (value.values.getValue("series") as JsonArray).values.map { entry ->
            entry as JsonObject
            ChartSeries(
                entry.str("name"),
                (entry.values.getValue("values") as JsonArray).values.map { (it as JsonNumber).source.toDouble() },
            )
        },
        title = value.optStr("title"),
        xTitle = value.optStr("xTitle"),
        yTitle = value.optStr("yTitle"),
    )

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value
    private fun JsonObject.optStr(key: String) = (values[key] as? JsonString)?.value

    private fun loadFixture(name: String) = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/$name") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/$name"),
            ),
            Charsets.UTF_8,
        ),
    )
}
