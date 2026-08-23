package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.remote.ChatMessage
import app.switchboard.mobile.domain.remote.LoadedSession
import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.domain.remote.MessageToolCall
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.MessagePill
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadedSessionSnapshotMapperTest {
    @Test
    fun `truncated history notice does not retain or present the raw response`() {
        val sentinel = "data:image/png;base64," + "A".repeat(2_000_000)
        val image = MessageImage(sentinel, "image/png", "large.png")
        val loaded = LoadedSession(
            messages = listOf(message("latest", "user", "", images = listOf(image))),
            meta = null,
            total = 501,
            truncated = true,
            raw = JsonObject(linkedMapOf("messages" to JsonString(sentinel))),
        )

        val feed = LoadedSessionSnapshotMapper.map("thread", loaded).feed
        val notice = feed
            .filterIsInstance<FeedItem.RawNotice>()
            .single()
        val expectedRaw = JsonObject(
            linkedMapOf(
                "shown" to JsonNumber("1"),
                "total" to JsonNumber("501"),
            ),
        )

        assertEquals("Showing the last 1 of 501 messages", notice.text)
        assertEquals(expectedRaw, notice.raw)
        assertFalse(JsonCodec.encode(notice.raw).contains(sentinel.take(64)))
        assertEquals(
            listOf(image),
            feed
                .filterIsInstance<FeedItem.User>()
                .single()
                .images,
        )
    }

    @Test
    fun `history window notice requires positive truncation and a known total`() {
        fun noticeCount(truncated: Boolean?, total: Long?) = LoadedSessionSnapshotMapper.map(
            "thread",
            LoadedSession(
                messages = listOf(message("latest", "assistant", "done")),
                meta = null,
                total = total,
                truncated = truncated,
                raw = JsonObject(linkedMapOf()),
            ),
        ).feed.count { it.id == "history-window" }

        assertEquals(1, noticeCount(true, 501))
        assertEquals(0, noticeCount(false, 501))
        assertEquals(0, noticeCount(null, 501))
        assertEquals(0, noticeCount(true, null))
    }

    @Test
    fun `history prefers display body and filters recognized synthetic context`() {
        val loaded = LoadedSession(
            messages = listOf(
                message(
                    "visible",
                    "user",
                    "context wrapper\n\nshow this",
                    displayBody = "[[pill:selection-1]] show this",
                    pillsMeta = mapOf("selection-1" to MessagePill("Admin panel", "chat-message")),
                ),
                message("synthetic", "user", "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>"),
            ),
            meta = null,
            total = 2,
            truncated = false,
            raw = JsonObject(linkedMapOf()),
        )

        val users = LoadedSessionSnapshotMapper.map("thread", loaded).feed.filterIsInstance<FeedItem.User>()
        assertEquals(listOf("[[pill:selection-1]] show this"), users.map(FeedItem.User::text))
        assertEquals(
            mapOf("selection-1" to MessagePill("Admin panel", "chat-message")),
            users.single().pillsMeta,
        )
    }
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
        assertEquals(JsonObject(linkedMapOf("path" to JsonString("README.md"))), tool.input)
        assertEquals("ok", tool.output)
        assertTrue(tool.state == "done")
    }

    private fun message(
        id: String,
        role: String,
        content: String,
        images: List<MessageImage> = emptyList(),
        toolCalls: List<MessageToolCall> = emptyList(),
        displayBody: String? = null,
        pillsMeta: Map<String, MessagePill> = emptyMap(),
    ) = ChatMessage(
        id = id,
        role = role,
        content = content,
        timestamp = 1,
        raw = JsonObject(linkedMapOf()),
        images = images,
        toolCalls = toolCalls,
        displayBody = displayBody,
        pillsMeta = pillsMeta,
    )
}
