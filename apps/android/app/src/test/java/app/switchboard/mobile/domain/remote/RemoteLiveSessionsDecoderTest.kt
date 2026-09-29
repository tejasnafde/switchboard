package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteLiveSessionsDecoderTest {
    @Test
    fun `list-sessions maps each live thread to its current status`() {
        val reply = JsonCodec.parse(
            """
            [
              {"threadId":"idle-chat","provider":"claude","status":"idle","runtimeMode":"sandbox","cwd":"/repo","createdAt":1},
              {"threadId":"busy-chat","provider":"codex","status":"running","runtimeMode":"sandbox","cwd":"/repo","createdAt":2},
              {"threadId":"","status":"running"},
              {"threadId":"no-status"}
            ]
            """.trimIndent(),
        )

        assertEquals(
            mapOf("idle-chat" to "idle", "busy-chat" to "running"),
            RemoteDecoders.liveSessionStatuses(reply),
        )
        assertEquals(emptyMap<String, String>(), RemoteDecoders.liveSessionStatuses(JsonNull))
    }
}
