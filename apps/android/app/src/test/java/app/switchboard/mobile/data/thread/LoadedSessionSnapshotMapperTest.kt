package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.remote.ChatMessage
import app.switchboard.mobile.domain.remote.LoadedSession
import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.domain.remote.MessageToolCall
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadedSessionSnapshotMapperTest {
    @Test
    fun `image-only history stays visible and assistant tool calls become rows`() {
        val image = MessageImage(
            url = "data:image/png;base64,iVBORw0KGgo=",
            mimeType = "image/png",
            name = "screen.png",
        )
        val loaded = LoadedSession(
            messages = listOf(
                message("user", "user", "", images = listOf(image)),
                message(
                    "assistant",
                    "assistant",
                    "done",
                    toolCalls = listOf(MessageToolCall("tool-1", "Read", "{\"path\":\"README.md\"}", "ok")),
                ),
            ),
            meta = null,
            total = 2,
            truncated = false,
            raw = JsonObject(linkedMapOf()),
        )

        val feed = LoadedSessionSnapshotMapper.map("thread", loaded).feed

        assertEquals(listOf("h-user", "h-assistant", "h-assistant-t-tool-1"), feed.map(FeedItem::id))
        assertEquals(listOf(image), (feed[0] as FeedItem.User).images)
        val tool = feed[2] as FeedItem.Tool
        assertEquals("Read", tool.toolName)
        assertEquals(JsonString("{\"path\":\"README.md\"}"), tool.input)
        assertEquals("ok", tool.output)
        assertTrue(tool.state == "done")
    }

    private fun message(
        id: String,
        role: String,
        content: String,
        images: List<MessageImage> = emptyList(),
        toolCalls: List<MessageToolCall> = emptyList(),
    ) = ChatMessage(
        id = id,
        role = role,
        content = content,
        timestamp = 1,
        raw = JsonObject(linkedMapOf()),
        images = images,
        toolCalls = toolCalls,
    )
}
