package app.switchboard.mobile.platform.notification

import app.switchboard.mobile.domain.thread.ThreadEventDecoder
import app.switchboard.mobile.domain.thread.ThreadEventPayload
import app.switchboard.mobile.domain.thread.ThreadRuntimeEvent
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.RuntimeEventPayload
import java.util.Locale

data class NotificationThreadMetadata(
    val title: String? = null,
    val projectPath: String? = null,
    val connectionLabel: String? = null,
)

data class TurnCompletionNotification(
    val title: String,
    val body: String,
    val route: NotificationThreadRoute,
)

fun interface TurnCompletionNotifier {
    /** False means delivery was unavailable, for example permission was denied. */
    fun post(notification: TurnCompletionNotification): Boolean
}

object TurnCompletionNotificationPolicy {
    fun body(durationMs: Long?): String = when {
        durationMs == null || durationMs <= 0 -> "Done"
        else -> "Done in ${formatDuration(durationMs)}"
    }

    private fun formatDuration(durationMs: Long): String = when {
        durationMs < 60_000 -> String.format(Locale.US, "%.1fs", durationMs / 1_000.0)
        durationMs < 3_600_000 -> "${durationMs / 60_000}m ${(durationMs % 60_000) / 1_000}s"
        else -> "${durationMs / 3_600_000}h ${(durationMs % 3_600_000) / 60_000}m"
    }
}

/**
 * Filters process-alive socket events into background completion notifications.
 * The current-scope check prevents a replaced connection generation from
 * surfacing a stale callback.
 */
class BackgroundTurnNotificationCoordinator(
    private val isForeground: () -> Boolean,
    private val currentScope: (connectionId: String) -> TransportScope?,
    private val metadata: (connectionId: String, threadId: String) -> NotificationThreadMetadata,
    private val notifier: TurnCompletionNotifier,
) {
    private val notifiedTurnIds = linkedSetOf<String>()

    @Synchronized
    fun onRuntimeEvent(scope: TransportScope, event: RuntimeEventPayload): Boolean {
        if (isForeground() || currentScope(scope.connectionId) != scope) return false
        if (event.type != TURN_COMPLETED || event.threadId.isBlank()) return false
        val decoded = ThreadEventDecoder.decode(event.raw) as? ThreadRuntimeEvent.Known ?: return false
        if (decoded.type != event.type || decoded.threadId != event.threadId) return false
        val completion = decoded.payload as? ThreadEventPayload.TurnCompleted ?: return false
        val baseRoute = NotificationRouteCodec.normalize(
            NotificationThreadRoute(scope.connectionId, event.threadId),
        ) ?: return false
        val dedupeKey = completion.turnId
            ?.takeIf { it.isNotBlank() && it.length <= MAX_TURN_ID_LENGTH }
            ?.let {
                "${scope.connectionId}:${scope.generation}:${event.threadId}:$it"
            }
        if (dedupeKey != null && dedupeKey in notifiedTurnIds) return false

        val hints = try {
            metadata(scope.connectionId, event.threadId)
        } catch (_: Exception) {
            NotificationThreadMetadata()
        }
        val route = NotificationRouteCodec.normalize(
            baseRoute.copy(
                titleHint = hints.title,
                projectPathHint = hints.projectPath,
                connectionLabelHint = hints.connectionLabel,
            ),
        ) ?: return false
        val posted = try {
            notifier.post(
                TurnCompletionNotification(
                    title = DEFAULT_TITLE,
                    body = TurnCompletionNotificationPolicy.body(completion.durationMs),
                    route = route,
                ),
            )
        } catch (_: Exception) {
            false
        }
        if (posted && dedupeKey != null) remember(dedupeKey)
        return posted
    }

    private fun remember(key: String) {
        notifiedTurnIds += key
        while (notifiedTurnIds.size > MAX_DEDUPE_TURNS) {
            notifiedTurnIds.remove(notifiedTurnIds.first())
        }
    }

    private companion object {
        const val TURN_COMPLETED = "turn.completed"
        const val DEFAULT_TITLE = "Switchboard"
        const val MAX_TURN_ID_LENGTH = 512
        const val MAX_DEDUPE_TURNS = 128
    }
}
