package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadFeedLayoutPolicyTest {
    @Test
    fun `reverse layout declares newest row first`() {
        val chronological = listOf("oldest", "middle", "newest")

        assertEquals(
            listOf("newest", "middle", "oldest"),
            ThreadFeedLayoutPolicy.declarationOrder(chronological),
        )
    }

    @Test
    fun `reverse layout preserves an empty feed`() {
        assertEquals(
            emptyList<String>(),
            ThreadFeedLayoutPolicy.declarationOrder(emptyList<String>()),
        )
    }
}
