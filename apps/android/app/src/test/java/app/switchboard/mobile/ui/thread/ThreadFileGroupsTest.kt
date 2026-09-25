package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.FeedItem
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadFileGroupsTest {
    private val rows = listOf(
        FeedItem.User("u1", "first", 1),
        FeedItem.Text("t1", "m1", "done", "assistant"),
        FeedItem.FileEdit("f-a", "a", "/repo", "a.kt", "modify", "x", "y"),
        FeedItem.FileEdit("f-b", "b", "/repo", "b.kt", "add", "", "one\ntwo"),
        FeedItem.User("u2", "second", 2),
        FeedItem.FileEdit("f-c", "c", "/repo", "c.kt", "modify", "x", "z"),
        FeedItem.Text("t2", "m2", "done again", "assistant"),
    ).map(ThreadPresenter::row)

    @Test
    fun eachTurnsFilesFoldBehindOneCollapsedRowWhereTheFirstFileWas() {
        val collapsed = ThreadFileGroups.collapse(rows, expanded = emptySet())

        assertEquals(listOf("u1", "t1", "files:f-a", "u2", "files:f-c", "t2"), collapsed.map { it.key })
        val first = collapsed[2] as ThreadRowPresentation.FileGroup
        assertEquals("Changed 2 files", first.label)
        assertEquals(false, first.expanded)
        assertEquals(1 + 2, first.addedLines)
        assertEquals("Changed 1 file", (collapsed[4] as ThreadRowPresentation.FileGroup).label)
    }

    @Test
    fun expandingATurnShowsOnlyThatTurnsFiles() {
        val expanded = ThreadFileGroups.collapse(rows, expanded = setOf("files:f-a"))

        assertEquals(listOf("u1", "t1", "files:f-a", "f-a", "f-b", "u2", "files:f-c", "t2"), expanded.map { it.key })
        assertEquals(true, (expanded[2] as ThreadRowPresentation.FileGroup).expanded)
    }

    @Test
    fun aFeedWithoutFileEditsIsUnchanged() {
        val plain = rows.filterNot { it is ThreadRowPresentation.FileEdit }
        assertEquals(plain, ThreadFileGroups.collapse(plain, emptySet()))
    }
}
