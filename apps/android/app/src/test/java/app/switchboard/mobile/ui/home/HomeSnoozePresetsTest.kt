package app.switchboard.mobile.ui.home

import app.switchboard.mobile.data.remote.ChatSnoozeStore
import app.switchboard.mobile.domain.remote.ChatSnooze
import java.util.GregorianCalendar
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Test

/** The Snooze sheet resolves the machine's own presets, and the defaults for a backend without them. */
class HomeSnoozePresetsTest {
    private val zone = TimeZone.getTimeZone("Europe/London")

    /** Monday 2 November 2026, 10:00 on the device. */
    private val monday = GregorianCalendar(zone).apply {
        clear()
        set(2026, 10, 2, 10, 0, 0)
    }.timeInMillis

    private val row = HomeRecentRow(
        connectionId = "mac",
        connectionLabel = "Mac",
        threadId = "t1",
        title = "Chat",
        projectPath = "/repo",
        projectName = "repo",
        provider = "claude-code",
        worktreePath = null,
        worktreeBranch = null,
        startedAt = 1,
        status = null,
        unread = 0,
        snoozable = true,
    )

    @Test
    fun `the sheet lists the machine presets soonest first, then the PR`() {
        val defaultZone = TimeZone.getDefault()
        TimeZone.setDefault(zone)
        try {
            val presets = listOf(
                ChatSnooze.PresetSpec.Weekday("Friday wrap-up", weekday = 5, hour = 16, minute = 0),
                ChatSnooze.PresetSpec.Time("Lunch", dayOffset = 0, hour = 13, minute = 0),
            )
            val sheet = HomeSnoozeSheet(row, monday, pr = ChatSnooze.PrChoice("github:acme/app#7", 7), presets = presets)
            assertEquals(
                listOf("Lunch" to "13:00", "Friday wrap-up" to "Fri 16:00", "Until PR #7 changes" to ""),
                sheet.items.map { it.label to it.detail },
            )
        } finally {
            TimeZone.setDefault(defaultZone)
        }
    }

    @Test
    fun `a machine whose presets were never read uses the defaults, and a read or broadcast replaces them`() {
        val store = ChatSnoozeStore()
        assertEquals(ChatSnooze.DEFAULT_PRESETS, store.presetsOf("mac"))
        val lunch = listOf(ChatSnooze.PresetSpec.Time("Lunch", dayOffset = 0, hour = 13, minute = 0))
        store.putPresets("mac", lunch)
        assertEquals(lunch, store.presetsOf("mac"))
        assertEquals(ChatSnooze.DEFAULT_PRESETS, store.presetsOf("vm"))
        assertEquals(ChatSnooze.DEFAULT_PRESETS, HomeSnoozeSheet(row, monday).presets)
    }
}
