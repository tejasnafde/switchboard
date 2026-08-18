package app.switchboard.mobile.platform.notification

import android.content.Context

class AndroidNotificationRouteStorage(
    context: Context,
) : NotificationRouteStorage {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun read(): NotificationRouteInboxState {
        val tapId = preferences.getString(PENDING_TAP_ID, null)
        val payload = mapOf(
            NotificationRouteCodec.CONNECTION_ID_KEY to preferences.getString(CONNECTION_ID, null),
            NotificationRouteCodec.THREAD_ID_KEY to preferences.getString(THREAD_ID, null),
            NotificationRouteCodec.TITLE_KEY to preferences.getString(TITLE, null),
            NotificationRouteCodec.PROJECT_PATH_KEY to preferences.getString(PROJECT_PATH, null),
            NotificationRouteCodec.CONNECTION_LABEL_KEY to preferences.getString(CONNECTION_LABEL, null),
        )
        val pending = if (tapId == null) {
            null
        } else {
            NotificationRouteCodec.parse(payload)?.let { PendingNotificationRoute(tapId, it) }
        }
        return NotificationRouteInboxState(
            pending = pending,
            consumedTapIds = preferences.getStringSet(CONSUMED_TAP_IDS, emptySet()).orEmpty().toList(),
        )
    }

    override fun write(state: NotificationRouteInboxState): Boolean {
        val editor = preferences.edit().clear()
            .putStringSet(CONSUMED_TAP_IDS, state.consumedTapIds.toSet())
        state.pending?.let { pending ->
            editor.putString(PENDING_TAP_ID, pending.tapId)
            NotificationRouteCodec.encode(pending.route).forEach { (key, value) ->
                editor.putString(preferenceKey(key), value)
            }
        }
        return editor.commit()
    }

    private fun preferenceKey(payloadKey: String): String = when (payloadKey) {
        NotificationRouteCodec.CONNECTION_ID_KEY -> CONNECTION_ID
        NotificationRouteCodec.THREAD_ID_KEY -> THREAD_ID
        NotificationRouteCodec.TITLE_KEY -> TITLE
        NotificationRouteCodec.PROJECT_PATH_KEY -> PROJECT_PATH
        NotificationRouteCodec.CONNECTION_LABEL_KEY -> CONNECTION_LABEL
        else -> error("Unsupported notification route key")
    }

    private companion object {
        const val PREFERENCES_NAME = "native-notification-route"
        const val PENDING_TAP_ID = "pending.tap-id"
        const val CONNECTION_ID = "pending.connection-id"
        const val THREAD_ID = "pending.thread-id"
        const val TITLE = "pending.title"
        const val PROJECT_PATH = "pending.project-path"
        const val CONNECTION_LABEL = "pending.connection-label"
        const val CONSUMED_TAP_IDS = "consumed.tap-ids"
    }
}
