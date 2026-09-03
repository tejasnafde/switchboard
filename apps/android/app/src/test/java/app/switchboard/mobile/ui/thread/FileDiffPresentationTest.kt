package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileDiffPresentationTest {
    @Test
    fun insertionKeepsStableOldAndNewLineNumbers() {
        val diff = FileDiffPresenter.present(
            oldContent = "alpha\nbeta\ngamma",
            newContent = "alpha\ninserted\nbeta\ngamma",
        )

        assertEquals(1, diff.addedLines)
        assertEquals(0, diff.removedLines)
        assertEquals(
            listOf(
                CompactDiffLine(DiffLineKind.Context, "alpha", oldLine = 1, newLine = 1),
                CompactDiffLine(DiffLineKind.Added, "inserted", oldLine = null, newLine = 2),
                CompactDiffLine(DiffLineKind.Context, "beta", oldLine = 2, newLine = 3),
                CompactDiffLine(DiffLineKind.Context, "gamma", oldLine = 3, newLine = 4),
            ),
            diff.lines,
        )
    }

    @Test
    fun replacementReportsSeparateRemovalAndAddition() {
        val diff = FileDiffPresenter.present("before", "after")

        assertEquals(1, diff.addedLines)
        assertEquals(1, diff.removedLines)
        assertEquals(
            listOf(DiffLineKind.Removed, DiffLineKind.Added),
            diff.lines.map(CompactDiffLine::kind),
        )
    }

    @Test
    fun largeDiffIsBoundedAndExplicitlyMarkedAsTruncated() {
        val old = (1..1_000).joinToString("\n") { "old-$it" }
        val new = (1..1_000).joinToString("\n") { "new-$it" }

        val diff = FileDiffPresenter.present(old, new)

        assertTrue(diff.truncated)
        assertTrue(diff.lines.size <= FileDiffPresenter.MAX_VISIBLE_ROWS)
        assertEquals(1_000, diff.addedLines)
        assertEquals(1_000, diff.removedLines)
    }

    @Test
    fun oneEmptySideIsNotAlignableRegardlessOfTheOtherSize() {
        // The cell product is zero when a side is empty, so the product test alone
        // admitted a created or deleted file of any size.
        assertFalse(FileDiffPresenter.alignable(0, 50_000))
        assertFalse(FileDiffPresenter.alignable(50_000, 0))
        assertFalse(FileDiffPresenter.alignable(1, 200_000))
        assertTrue(FileDiffPresenter.alignable(0, 3_000))
        assertFalse(FileDiffPresenter.alignable(0, 3_001))
        assertFalse(FileDiffPresenter.alignable(3_001, 0))
    }

    @Test
    fun ordinaryEditsRemainAlignable() {
        assertTrue(FileDiffPresenter.alignable(3, 4))
        assertTrue(FileDiffPresenter.alignable(300, 300))
    }

    @Test
    fun hugeFilesFallBackAndStayWithinTheVisibleRowCap() {
        val body = (1..50_000).joinToString("\n") { "line $it" }

        val created = FileDiffPresenter.present("", body)
        val deleted = FileDiffPresenter.present(body, "")
        assertFalse(created.countsExact)
        assertFalse(deleted.countsExact)
        assertTrue(created.lines.size <= FileDiffPresenter.MAX_VISIBLE_ROWS)
        assertTrue(deleted.lines.size <= FileDiffPresenter.MAX_VISIBLE_ROWS)
    }
}
