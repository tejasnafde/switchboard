package app.switchboard.mobile.ui.thread

object ThreadTestTags {
    const val FEED = "thread-feed"
    const val COMPOSER_INPUT = "thread-composer-input"
    const val AGENT_SETTINGS_ACTION = "thread-agent-settings-action"
    const val AGENT_SETTINGS_SCREEN = "thread-agent-settings-screen"
    const val AGENT_SETTINGS_BACK = "thread-agent-settings-back"
    const val ARCHIVE_ACTION = "thread-archive-action"
    const val ARCHIVE_CONFIRM = "thread-archive-confirm"
    const val APPROVAL_SLOT = "thread-approval-slot"

    fun toolContainer(key: String) = "thread-tool-container:$key"
    fun toolRow(key: String) = "thread-tool-row:$key"
    fun toolStatus(key: String) = "thread-tool-status:$key"
    fun toolLabel(key: String) = "thread-tool-label:$key"
    fun toolDetail(key: String) = "thread-tool-detail:$key"
    fun toolDisclosure(key: String) = "thread-tool-disclosure:$key"
    fun toolOutput(key: String) = "thread-tool-output:$key"
    fun toolOutputList(key: String) = "thread-tool-output-list:$key"
}
