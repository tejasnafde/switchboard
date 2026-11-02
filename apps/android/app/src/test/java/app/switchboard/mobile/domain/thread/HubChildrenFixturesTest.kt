package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs the hub client vectors of tests/fixtures/hub-cases.json, the ones tests/unit/hub-rules.test.ts checks. */
class HubChildrenFixturesTest {
    private val fixture = loadFixture() as JsonObject

    @Test
    fun theStateTextMatchesTheSharedRule() {
        val cases = section("childStateText")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val name = case.string("name")
            val input = case.obj("input")
            val expected = case.obj("expected")
            val child = child(
                state = input.string("state")!!,
                waitingForSlot = (input.values["waitingForSlot"] as? JsonBoolean)?.value == true,
                remote = HubChildren.remote(input.values["remote"]),
            )
            assertEquals(name, expected.string("label"), HubChildren.childStateLabel(child))
            assertEquals(name, expected.string("word"), HubChildren.childStateWord(child))
        }
    }

    @Test
    fun theChildCountMatchesTheSharedRule() {
        val cases = section("childrenCount")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val children = (case.values.getValue("input") as JsonArray).values.map { machine ->
                child(
                    state = "working",
                    remote = (machine as? JsonString)?.value?.let {
                        HubRemoteChild(machineId = it, machine = it, connected = true, ageMs = 0, stopping = false)
                    },
                )
            }
            assertEquals(case.string("name"), case.string("expected"), HubChildren.childrenCount(children))
        }
    }

    @Test
    fun stopMatchesTheSharedRule() {
        val cases = section("childStop")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val name = case.string("name")
            val input = case.obj("input")
            val expected = case.obj("expected")
            val child = child(
                state = input.string("state")!!,
                phase = input.string("phase")!!,
                chatId = input.string("chatId")!!,
                liveId = input.string("liveId"),
                remote = HubChildren.remote(input.values["remote"]),
            )
            assertEquals(name, (expected.values.getValue("canStop") as JsonBoolean).value, HubChildren.canStop(child))
            assertEquals(name, expected.string("target"), HubChildren.stopTarget(child))
        }
    }

    private fun child(
        state: String,
        waitingForSlot: Boolean = false,
        remote: HubRemoteChild? = null,
        phase: String = "open",
        chatId: String = "c1",
        liveId: String? = null,
    ) = HubChildView(
        chat = HubChatRef(chatId, listOf(chatId), "Child", "claude-code", "/repo", 0),
        liveId = liveId,
        phase = requireNotNull(HubChildPhase.fromWire(phase)) { phase },
        state = ChildState.fromWire(state) ?: ChildState.Unknown,
        waitingForSlot = waitingForSlot,
        remote = remote,
    )

    private fun section(name: String) = (fixture.values.getValue(name) as JsonArray).values.map { it as JsonObject }

    private fun JsonObject.obj(key: String) = values.getValue(key) as JsonObject

    private fun JsonObject.string(key: String): String? = when (val value = values[key]) {
        is JsonString -> value.value
        null, JsonNull -> null
        else -> error("$key is not a string")
    }

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/hub-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/hub-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
