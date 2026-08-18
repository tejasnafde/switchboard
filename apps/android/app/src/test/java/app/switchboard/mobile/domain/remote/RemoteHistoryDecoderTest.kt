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

    private fun obj(vararg fields: Pair<String, app.switchboard.mobile.protocol.JsonValue>) =
        JsonObject(linkedMapOf(*fields))
}
