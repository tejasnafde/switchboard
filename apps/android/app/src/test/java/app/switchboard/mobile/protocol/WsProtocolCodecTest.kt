package app.switchboard.mobile.protocol

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WsProtocolCodecTest {
    @Test
    fun committedTypeScriptGoldensDecodeAndEncodeByteForByte() {
        val fixture = JsonCodec.parse(fixtureFile("ws-frames.json").readText()).requireArray()

        assertEquals(10, fixture.values.size)
        fixture.values.forEach { entryValue ->
            val entry = entryValue.requireObject()
            val name = entry.requireString("name")
            val wire = entry.requireString("wire")
            val expected = entry.requireValue("expected")
            val frame = assertNotNullWithValue(name, WsProtocol.decode(wire))

            assertEquals(name, expected, frame.toJson())
            assertEquals(name, wire, WsProtocol.encode(frame))
        }
    }

    @Test
    fun malformedOrCredentialFreeAuthenticationFramesAreRejected() {
        assertEquals(null, WsProtocol.decode("not json"))
        assertEquals(null, WsProtocol.decode("""{"k":"req","id":1}"""))
        assertEquals(null, WsProtocol.decode("""{"k":"auth"}"""))
    }

    @Test
    fun successfulResponsesCanCarryDomainLevelFailuresWithoutBeingCollapsed() {
        val wire =
            """{"k":"res","id":19,"ok":true,"result":{"ok":false,"code":"display_unsupported","message":"No hardware display"}}"""
        val response = assertNotNullWithValue("domain response", WsProtocol.decode(wire))
        assertTrue(response is WsFrame.Response.Success)

        val result = assertNotNullWithValue(
            "domain result",
            (response as WsFrame.Response.Success).result,
        ).requireObject()
        assertEquals(false, result.requireBoolean("ok"))
        assertEquals("display_unsupported", result.requireString("code"))
        assertEquals(wire, WsProtocol.encode(response))
    }

    @Test
    fun runtimeEventsPreserveEveryKnownTypeAndUnknownExtensions() {
        val knownTypes = listOf(
            "content",
            "user.message",
            "tool.started",
            "tool.completed",
            "tool.denied",
            "request.opened",
            "request.closed",
            "turn.completed",
            "turn.retrying",
            "error",
            "status",
            "session",
            "session.provider",
            "context_window",
            "model.variants",
            "plan.proposed",
            "question.asked",
            "question.answered",
            "file.edited",
            "worktree.drift",
            "spend.blocked",
            "thread.read",
            "peer.message",
            "todo.updated",
        )

        knownTypes.forEach { type ->
            val raw = JsonObject(
                linkedMapOf(
                    "type" to JsonString(type),
                    "threadId" to JsonString("thread-1"),
                    "futureField" to JsonNumber("17"),
                ),
            )
            val event = assertNotNullWithValue(type, RuntimeEventPayload.parse(raw))
            assertEquals(type, event.type)
            assertEquals(RuntimeEventKind.Known, event.kind)
            assertEquals(raw, event.raw)
        }

        val extension = assertNotNullWithValue(
            "extension",
            RuntimeEventPayload.parse(
                JsonObject(
                    linkedMapOf(
                        "type" to JsonString("provider.future-event"),
                        "threadId" to JsonString("thread-1"),
                    ),
                ),
            ),
        )
        assertEquals(RuntimeEventKind.Extension, extension.kind)
    }

    private fun fixtureFile(name: String): File {
        var cursor = File(System.getProperty("user.dir")).canonicalFile
        repeat(6) {
            val candidate = File(cursor, "tests/fixtures/mobile-native/protocol/$name")
            if (candidate.isFile) return candidate
            cursor = cursor.parentFile ?: cursor
        }
        error("Unable to locate committed protocol fixture $name")
    }

    private fun <T : Any> assertNotNullWithValue(label: String, value: T?): T {
        assertNotNull(label, value)
        return value!!
    }
}
