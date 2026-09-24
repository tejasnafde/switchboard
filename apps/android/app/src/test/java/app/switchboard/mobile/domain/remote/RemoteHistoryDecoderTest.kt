package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteHistoryDecoderTest {
    @Test
    fun `loaded session decodes the existing image and tool call wire contract exactly`() {
        val loaded = RemoteDecoders.loadedSession(
            obj(
                "messages" to JsonArray(
                    listOf(
                        obj(
                            "id" to JsonString("m-1"),
                            "role" to JsonString("user"),
                            "content" to JsonString(""),
                            "timestamp" to JsonNumber("42"),
                            "images" to JsonArray(
                                listOf(
                                    obj(
                                        "url" to JsonString("data:image/jpeg;base64,/9j/"),
                                        "mimeType" to JsonString("image/jpeg"),
                                        "name" to JsonString("photo.jpg"),
                                    ),
                                ),
                            ),
                            "toolCalls" to JsonArray(
                                listOf(
                                    obj(
                                        "id" to JsonString("t-1"),
                                        "name" to JsonString("Bash"),
                                        "input" to JsonString("pwd"),
                                        "output" to JsonString("/repo"),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
                "meta" to JsonNull,
                "total" to JsonNumber("1"),
                "truncated" to JsonBoolean(false),
            ),
        )

        assertEquals(
            listOf(MessageImage("data:image/jpeg;base64,/9j/", "image/jpeg", "photo.jpg")),
            loaded.messages.single().images,
        )
        assertEquals(
            listOf(MessageToolCall("t-1", "Bash", "pwd", "/repo")),
            loaded.messages.single().toolCalls,
        )
    }

    @Test
    fun `loaded session decodes a mirrored changed-file card`() {
        val loaded = RemoteDecoders.loadedSession(
            obj(
                "messages" to JsonArray(
                    listOf(
                        obj(
                            "id" to JsonString("filediff_ab-1:src/a.ts"),
                            "role" to JsonString("assistant"),
                            "content" to JsonString(""),
                            "timestamp" to JsonNumber("42"),
                            "fileDiff" to obj(
                                "fileEditId" to JsonString("ab-1:src/a.ts"),
                                "repoRoot" to JsonString("/repo"),
                                "relPath" to JsonString("src/a.ts"),
                                "changeKind" to JsonString("add"),
                                "oldContent" to JsonString(""),
                                "newContent" to JsonString("b"),
                                "status" to JsonString("accepted"),
                            ),
                        ),
                    ),
                ),
                "meta" to JsonNull,
                "total" to JsonNumber("1"),
                "truncated" to JsonBoolean(false),
            ),
        )

        assertEquals(
            MessageFileDiff("ab-1:src/a.ts", "/repo", "src/a.ts", "add", "", "b"),
            loaded.messages.single().fileDiff,
        )
    }

    private fun obj(vararg fields: Pair<String, app.switchboard.mobile.protocol.JsonValue>) =
        JsonObject(linkedMapOf(*fields))
}
