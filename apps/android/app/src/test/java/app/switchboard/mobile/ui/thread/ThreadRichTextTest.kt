package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadRichTextTest {
    @Test
    fun `parser keeps rich inline meaning and accepts an unfinished streaming fence`() {
        val blocks = ThreadRichTextParser.parse(
            """# Result

Read **carefully**, use `code`, and open [docs](https://example.com).

```kotlin
val answer = 42""",
        )

        assertEquals("Result", (blocks[0] as RichTextBlock.Heading).plainText)
        val paragraph = blocks[1] as RichTextBlock.Paragraph
        assertTrue(paragraph.inlines.any { it is RichInline.Strong })
        assertTrue(paragraph.inlines.any { it is RichInline.Code && it.text == "code" })
        assertTrue(
            paragraph.inlines.any {
                it is RichInline.Link && it.href == "https://example.com" && it.plainText == "docs"
            },
        )
        assertEquals(
            RichTextBlock.Code("kotlin", "val answer = 42"),
            blocks[2],
        )
    }

    @Test
    fun `parser preserves list quote rule and gfm table structure`() {
        val blocks = ThreadRichTextParser.parse(
            """> note

- first
2. second

---

| Name | State |
| :--- | ---: |
| build | green |""",
        )

        assertTrue(blocks[0] is RichTextBlock.Quote)
        assertEquals(false, (blocks[1] as RichTextBlock.ListItem).ordered)
        assertEquals("2.", (blocks[2] as RichTextBlock.ListItem).marker)
        assertTrue(blocks[3] is RichTextBlock.Rule)
        val table = blocks[4] as RichTextBlock.Table
        assertEquals(listOf(RichTextAlignment.LEFT, RichTextAlignment.RIGHT), table.alignments)
        assertEquals("Name", table.header[0].plainText())
        assertEquals("green", table.rows.single()[1].plainText())
    }

    @Test
    fun `long plain streaming text stays a single inline span`() {
        val source = "a".repeat(20_000)

        val paragraph = ThreadRichTextParser.parse(source).single() as RichTextBlock.Paragraph

        assertEquals(listOf(RichInline.Text(source)), paragraph.inlines)
    }
}
