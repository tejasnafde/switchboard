package app.switchboard.mobile.platform.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemotePushNotificationPolicyTest {
    @Test
    fun `completion payload becomes canonical content free notification`() {
        val notification = RemotePushNotificationPolicy.completion(
            mapOf(
                "kind" to "done",
                "clientRef" to "mac-a",
                "threadId" to "thread-1",
                "title" to "Sensitive conversation title",
                "body" to "Sensitive generated content",
                "projectPath" to "/repo",
            ),
        )

        assertEquals("Switchboard", notification?.title)
        assertEquals("Done", notification?.body)
        assertEquals(
            NotificationThreadRoute(
                connectionId = "mac-a",
                threadId = "thread-1",
                titleHint = "Sensitive conversation title",
                projectPathHint = "/repo",
            ),
            notification?.route,
        )
    }

    @Test
    fun `non completion and malformed routes are ignored`() {
        assertNull(
            RemotePushNotificationPolicy.completion(
                mapOf("kind" to "approval", "clientRef" to "mac-a", "threadId" to "thread-1"),
            ),
        )
        assertNull(RemotePushNotificationPolicy.completion(mapOf("kind" to "done", "threadId" to "thread-1")))
        assertNull(RemotePushNotificationPolicy.completion(mapOf("kind" to "done", "clientRef" to "mac-a")))
    }

    @Test
    fun `cold launch route uses bounded message id and exact payload`() {
        assertEquals(
            PendingNotificationRoute(
                tapId = "fcm-message-1",
                route = NotificationThreadRoute("mac-a", "thread-1"),
            ),
            RemotePushNotificationPolicy.coldTap(
                payload = mapOf("clientRef" to "mac-a", "threadId" to "thread-1"),
                messageId = "fcm-message-1",
                fallbackTapId = "fallback",
            ),
        )
        assertEquals(
            "fallback",
            RemotePushNotificationPolicy.coldTap(
                payload = mapOf("clientRef" to "mac-a", "threadId" to "thread-1"),
                messageId = "x".repeat(129),
                fallbackTapId = "fallback",
            )?.tapId,
        )
    }
}
