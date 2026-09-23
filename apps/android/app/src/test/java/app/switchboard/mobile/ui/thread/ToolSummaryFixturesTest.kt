package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs the SAME fixture file the shared TS module's vitest suite checks
 * (tests/unit/tool-summary-fixtures.test.ts) against native Android's own
 * tool-summary rules in ThreadPresentation.kt. Desktop, mobile and Android
 * used to have three independent implementations that labeled and shortened
 * paths differently; this file (plus the vitest one) is what proves they
 * still agree now that the rules live in one place (in spirit - Android has
 * no TypeScript runtime, so `toolSummary` here is a hand-written mirror, not
 * a shared binary).
 *
 * A case marked `"android": false` in the fixture is a documented,
 * intentional divergence - its `note` field explains why - and is skipped
 * here rather than asserted. See CHANGELOG.md and
 * docs/feature-parity/shared-tool-summary.json for the list.
 */
class ToolSummaryFixturesTest {
    @Test
    fun everyApplicableFixtureCaseMatchesNativeAndroidsToolSummary() {
        val cases = (loadFixture() as JsonArray).values.map { it as JsonObject }
        assertTrue("fixture must not be empty", cases.isNotEmpty())

        var applicable = 0
        var skipped = 0
        cases.forEach { case ->
            val id = (case.values.getValue("id") as JsonString).value
            val isAndroidCase = (case.values["android"] as? JsonBoolean)?.value ?: true
            if (!isAndroidCase) {
                skipped += 1
                return@forEach
            }
            applicable += 1

            val toolName = (case.values.getValue("toolName") as JsonString).value
            val expected = case.values.getValue("expected") as JsonObject
            val expectedLabel = (expected.values.getValue("label") as JsonString).value
            val expectedDetail = (expected.values.getValue("detail") as JsonString).value

            val row = ThreadPresenter.row(
                FeedItem.Tool(
                    id = "fixture-$id",
                    toolId = "fixture-$id",
                    toolName = toolName,
                    input = case.values["input"],
                    state = "done",
                ),
            ) as ThreadRowPresentation.Tool

            assertEquals("$id: label", expectedLabel, row.label)
            assertEquals("$id: detail", expectedDetail, row.detail)
        }

        // Sanity check on the split itself: a future edit that accidentally
        // marks every case "android": false would otherwise pass silently
        // with zero real assertions run.
        assertTrue("expected at least one android-applicable case", applicable > 0)
        assertTrue("expected fewer skipped than applicable cases", skipped < applicable)
    }

    private fun loadFixture(): JsonValue {
        val path = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .map { it.resolve("tests/fixtures/tool-summary-cases.json") }
            .firstOrNull(Files::exists)
            ?: error("Missing tests/fixtures/tool-summary-cases.json from ${Path.of("").toAbsolutePath()}")
        return JsonCodec.parse(String(Files.readAllBytes(path), Charsets.UTF_8))
    }
}
