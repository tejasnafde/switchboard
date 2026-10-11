package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.ui.thread.ThreadPresenter
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs the vectors tests/unit/subagent-steps.test.ts checks against the
 * TypeScript module, so both ports place and describe subagents the same way.
 */
class SubagentStepsFixturesTest {
    private val fixture = loadFixture() as JsonObject

    @Test
    fun everyLabelCaseMatches() {
        val cases = fixture.array("labels")
        assertTrue("labels must not be empty", cases.isNotEmpty())
        cases.forEach { case ->
            assertEquals(
                case.string("id"),
                case.string("label"),
                SyntheticUserMessage.backgroundTaskLabel(case.string("summary")!!),
            )
        }
    }

    @Test
    fun everyGroupingCaseMatches() {
        val cases = fixture.array("groupings")
        assertTrue("groupings must not be empty", cases.isNotEmpty())
        cases.forEach { case ->
            val entries = case.array("entries")
            val grouping = SubagentSteps.group(entries) { entry ->
                SubagentEntryFacts(
                    toolCalls = entry.arrayOrEmpty("toolCalls").map { call ->
                        SubagentToolCallFact(call.string("id")!!, call.string("name")!!, call.string("parentToolCallId"))
                    },
                    parentToolCallId = entry.string("parentToolCallId"),
                    noticeToolUseId = entry.string("noticeToolUseId"),
                )
            }
            val expected = case.values.getValue("expected") as JsonObject
            val id = case.string("id")
            assertEquals("$id: topLevel", expected.strings("topLevel"), grouping.topLevel.map { it.string("key") })
            assertEquals("$id: steps", expected.keyMap("steps"), grouping.stepsByAgent.keys(::keyOf))
            assertEquals("$id: completions", expected.keyMap("completions"), grouping.completionsByAgent.keys(::keyOf))
        }
    }

    @Test
    fun everyViewCaseMatches() {
        val cases = fixture.array("views")
        assertTrue("views must not be empty", cases.isNotEmpty())
        cases.forEach { case ->
            val id = case.string("id")
            val call = case.values.getValue("call") as JsonObject
            val view = SubagentSteps.view(
                SubagentCall(
                    input = call.values["input"],
                    output = call.string("output"),
                    isError = call.bool("isError"),
                    startedAt = call.long("startedAt"),
                ),
                case.array("steps").map(::step),
                case.array("completions").map { SubagentCompletion(notice(it.obj("part")), it.long("at")) },
                ThreadPresenter::toolStepLabel,
            )
            val expected = case.obj("expected")
            assertEquals("$id: description", expected.string("description"), view.description)
            assertEquals("$id: model", expected.string("model"), view.model)
            assertEquals("$id: status", expected.string("status"), view.status.name.lowercase())
            assertEquals("$id: statusText", expected.string("statusText"), SubagentSteps.statusText(view))
            assertEquals("$id: result", expected.string("result"), view.result)
            assertEquals("$id: items", expected.strings("items"), view.items.map(::itemCode))
        }
    }

    /** The fixture's string form of a row: `step:<key>`, `failed:<key>`, `more:<label>`, `notices:<label>`. */
    private fun itemCode(item: SubagentDisplayItem): String = when (item) {
        is SubagentDisplayItem.Step -> "${if (item.failed) "failed" else "step"}:${item.step.key}"
        is SubagentDisplayItem.More -> "more:${item.label}"
        is SubagentDisplayItem.Notices -> "notices:${item.label}"
    }

    private fun step(value: JsonObject): SubagentStep {
        val key = value.string("key")!!
        return when (value.string("kind")) {
            "tool" -> SubagentStep.Tool(
                key,
                value.string("toolName")!!,
                value.values["input"],
                value.string("output"),
                value.bool("isError"),
            )
            "notice" -> SubagentStep.Notice(key, notice(value.obj("part")))
            else -> SubagentStep.Text(key, value.string("text")!!)
        }
    }

    private fun notice(part: JsonObject) = SyntheticPart.TaskNotification(
        status = part.string("status")!!,
        summary = part.string("summary")!!,
        taskId = part.string("taskId"),
        outputFile = part.string("outputFile"),
        toolUseId = part.string("toolUseId"),
        result = part.string("result"),
    )

    private fun keyOf(entry: JsonObject) = entry.string("key")

    private fun Map<String, List<JsonObject>>.keys(key: (JsonObject) -> String?) =
        mapValues { (_, entries) -> entries.map(key) }

    private fun JsonObject.keyMap(name: String) = obj(name).values.mapValues { (_, value) ->
        (value as JsonArray).values.map { (it as JsonString).value }
    }

    private fun JsonObject.obj(key: String) = values.getValue(key) as JsonObject
    private fun JsonObject.array(key: String) = (values.getValue(key) as JsonArray).values.map { it as JsonObject }
    private fun JsonObject.arrayOrEmpty(key: String) =
        (values[key] as? JsonArray)?.values?.map { it as JsonObject }.orEmpty()
    private fun JsonObject.strings(key: String) = (values.getValue(key) as JsonArray).values.map { (it as JsonString).value }
    private fun JsonObject.string(key: String) = (values[key] as? JsonString)?.value
    private fun JsonObject.long(key: String) = (values[key] as? JsonNumber)?.source?.toLongOrNull()
    private fun JsonObject.bool(key: String) = (values[key] as? JsonBoolean)?.value == true

    private fun loadFixture(): JsonValue = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/subagent-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/subagent-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
