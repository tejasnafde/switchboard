package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.domain.thread.MessagePill
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteLoadedSessionDecoderTest {
    @Test
    fun `loaded user message carries validated pill metadata`() {
        val loaded = RemoteDecoders.loadedSession(
            obj(
                "messages" to arr(
                    obj(
                        "id" to string("user-1"),
                        "role" to string("user"),
                        "content" to string("expanded context"),
                        "timestamp" to JsonNumber("7"),
                        "toolCalls" to arr(),
                        "images" to arr(),
                        "displayBody" to string("[[pill:selection-1]] continue"),
                        "pillsMeta" to obj(
                            "selection-1" to obj(
                                "label" to string("Admin panel"),
                                "kind" to string("chat-message"),
                            ),
                            "invalid kind" to obj(
                                "label" to string("ignored"),
                                "kind" to string("unknown"),
                            ),
                        ),
                    ),
                ),
                "meta" to JsonNull,
            ),
        )

        assertEquals(
            mapOf("selection-1" to MessagePill("Admin panel", "chat-message")),
            loaded.messages.single().pillsMeta,
        )
    }

    private fun obj(vararg values: Pair<String, JsonValue>) =
        JsonObject(linkedMapOf(*values))

    private fun arr(vararg values: JsonValue) = JsonArray(values.toList())
    private fun string(value: String) = JsonString(value)
}
