package app.switchboard.mobile

object AppContract {
    const val RELEASE_APPLICATION_ID = "app.switchboard.mobile"
    const val DEBUG_APPLICATION_ID_SUFFIX = ".native.dev"
    const val VERSION_NAME = "0.5.0"
    const val VERSION_CODE = 2
    const val NOTIFICATION_CHANNEL_ID = "switchboard-agents"
    const val NOTIFICATION_CHANNEL_NAME = "Agent activity"

    val DEEP_LINK_SCHEMES = listOf(
        "switchboard",
        "com.googleusercontent.apps.974343814740-be31f3e59stdql81uke54r62aodb5c7q",
    )
}
