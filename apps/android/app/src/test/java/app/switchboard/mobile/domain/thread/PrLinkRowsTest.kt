package app.switchboard.mobile.domain.thread

import org.junit.Assert.assertEquals
import org.junit.Test

class PrLinkRowsTest {
    @Test
    fun chipLabelNamesTheFirstLinkAndCountsTheRest() {
        assertEquals("", PrLinkRows.chipLabel(emptyList()))
        assertEquals("#9", PrLinkRows.chipLabel(listOf(link(9))))
        assertEquals("#9 +1", PrLinkRows.chipLabel(listOf(link(9), link(10))))
        assertEquals("#9 +2", PrLinkRows.chipLabel(listOf(link(9), link(10), link(11))))
    }

    @Test
    fun sheetRowPutsTheRepositoryFirstAndCapitalisesTheState() {
        assertEquals(
            PrLinkSheetRow(primary = "#9 geoiq/switchboard", secondary = "Merged · Linked automatically"),
            PrLinkRows.sheetRow(link(9, source = "auto", state = "merged")),
        )
        assertEquals(
            PrLinkSheetRow(primary = "#12 geoiq/switchboard", secondary = "Opened by the agent"),
            PrLinkRows.sheetRow(link(12, source = "created", state = "open")),
        )
        assertEquals("Linked", PrLinkRows.sheetRow(link(3, source = "future")).secondary)
    }

    private fun link(number: Long, source: String = "manual", state: String? = null) = PrLink(
        ref = PrLinkRef(host = "github.com", owner = "geoiq", name = "switchboard", number = number),
        source = source,
        linkedAt = 0,
        state = state,
    )
}
