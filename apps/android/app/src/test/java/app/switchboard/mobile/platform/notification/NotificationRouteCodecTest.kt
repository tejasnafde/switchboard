package app.switchboard.mobile.platform.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationRouteCodecTest {
    @Test
    fun `requires authoritative backend and thread identifiers`() {
        assertNull(NotificationRouteCodec.parse(mapOf("threadId" to "thread-1")))
        assertNull(NotificationRouteCodec.parse(mapOf("clientRef" to "machine-1")))
        assertNull(NotificationRouteCodec.parse(mapOf("clientRef" to " ", "threadId" to "thread-1")))
        assertNull(NotificationRouteCodec.parse(mapOf("clientRef" to "machine-1", "threadId" to "")))
    }

    @Test
    fun `maps RN payload identity and keeps metadata as optional hints`() {
        val route = NotificationRouteCodec.parse(
            mapOf(
                "clientRef" to "machine-1",
                "threadId" to "thread-1",
                "title" to "Release work",
                "projectPath" to "/work/switchboard",
                "connectionLabel" to "Studio Mac",
                "token" to "must-not-be-copied",
                "body" to "must-not-be-copied",
            ),
        )

        assertEquals(
            NotificationThreadRoute(
                connectionId = "machine-1",
                threadId = "thread-1",
                titleHint = "Release work",
                projectPathHint = "/work/switchboard",
                connectionLabelHint = "Studio Mac",
            ),
            route,
        )
        assertEquals(
            setOf("clientRef", "threadId", "title", "projectPath", "connectionLabel"),
            NotificationRouteCodec.encode(requireNotNull(route)).keys,
        )
    }

    @Test
    fun `non-string optional values are ignored rather than guessed`() {
        assertEquals(
            NotificationThreadRoute("machine-1", "thread-1"),
            NotificationRouteCodec.parse(
                mapOf(
                    "clientRef" to "machine-1",
                    "threadId" to "thread-1",
                    "title" to 17,
                    "projectPath" to false,
                ),
            ),
        )
    }

    @Test
    fun `untrusted intent hints are bounded and oversized identities are rejected`() {
        val route = NotificationRouteCodec.parse(
            mapOf(
                "clientRef" to "machine-1",
                "threadId" to "thread-1",
                "title" to "t".repeat(1_000),
                "projectPath" to "p".repeat(10_000),
            ),
        )

        assertEquals(200, route?.titleHint?.length)
        assertEquals(4_096, route?.projectPathHint?.length)
        assertNull(
            NotificationRouteCodec.parse(
                mapOf("clientRef" to "m".repeat(513), "threadId" to "thread-1"),
            ),
        )
    }
}
