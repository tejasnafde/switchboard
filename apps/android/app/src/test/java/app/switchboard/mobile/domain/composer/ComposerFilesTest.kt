package app.switchboard.mobile.domain.composer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComposerFilesTest {
    private fun source(name: String, mimeType: String?, size: Long? = 10) =
        ComposerImageSource(contentUri = "content://x/$name", mimeType = mimeType, displayName = name, sizeBytes = size)

    @Test
    fun `sorts images, files and refusals`() {
        val intake = ComposerFiles.sort(
            listOf(
                source("a.png", "image/png"),
                source("b.HEIC", null),
                source("c.svg", "image/svg+xml"),
                source("d.tiff", "image/tiff"),
                source("e.pdf", "application/pdf"),
                source("f.zip", "application/zip", size = ComposerFiles.MAX_UPLOAD_BYTES + 1),
            ),
            uploads = true,
        )
        assertEquals(listOf("a.png", "b.HEIC"), intake.images.map { it.displayName })
        assertEquals(listOf("c.svg", "e.pdf"), intake.files.map { it.displayName })
        assertEquals(
            listOf(
                "d.tiff was not attached: TIFF images are not supported. Use PNG, JPEG, WebP, GIF or HEIC.",
                "f.zip was not attached: 11 MB is over the 10 MB file limit.",
            ),
            intake.refused,
        )
    }

    @Test
    fun `takes images only without the upload capability`() {
        val intake = ComposerFiles.sort(listOf(source("a.jpg", "image/jpeg"), source("notes.txt", "text/plain")), uploads = false)
        assertEquals(listOf("a.jpg"), intake.images.map { it.displayName })
        assertEquals(emptyList<ComposerImageSource>(), intake.files)
        assertEquals(
            listOf("notes.txt was not attached: Only images can be attached. Update Switchboard on the computer to attach other files."),
            intake.refused,
        )
    }

    @Test
    fun `names the next pasted text after the highest one`() {
        assertEquals("pasted-text-1.txt", ComposerFiles.nextPastedTextName(emptyList()))
        assertEquals(
            "pasted-text-4.txt",
            ComposerFiles.nextPastedTextName(listOf("pasted-text-3.txt (40 lines)", "a.pdf", "pasted-text-1.txt")),
        )
    }

    @Test
    fun `labels pages and lines only when more than one`() {
        assertEquals("spec.pdf (12 pages)", ComposerFiles.label("spec.pdf", pages = 12))
        assertEquals("log.txt (2,140 lines)", ComposerFiles.label("log.txt", lines = 2140))
        assertEquals("one.pdf", ComposerFiles.label("one.pdf", pages = 1, lines = 1))
        assertEquals(3, ComposerFiles.lineCount("a\nb\nc"))
    }

    @Test
    fun `finds a large paste and keeps the text around it`() {
        val big = "x".repeat(ComposerFiles.LARGE_PASTE_BYTES + 1)
        val paste = ComposerFiles.largePaste("hello world", "hello $big world")
        assertEquals(big, paste?.inserted?.trim())
        assertEquals("hello world", paste?.kept)
        // Exactly at the limit stays inline; UTF-8 bytes count, not characters.
        assertNull(ComposerFiles.largePaste("", "x".repeat(ComposerFiles.LARGE_PASTE_BYTES)))
        val wide = "é".repeat(ComposerFiles.LARGE_PASTE_BYTES / 2 + 1)
        assertEquals(wide, ComposerFiles.largePaste("", wide)?.inserted)
        // A replacement is not a paste into the text.
        assertNull(ComposerFiles.largePaste("abc", "z$big"))
        assertNull(ComposerFiles.largePaste("abc", "ab"))
    }

    @Test
    fun `round-trips an uploaded file through a draft attachment`() {
        val file = UploadedFile("a \"b\".pdf", "/data/attachments/u1/a \"b\".pdf", "a \"b\".pdf (3 pages)")
        val attachment = ComposerFiles.attachment("id1", file)
        assertEquals(ComposerFiles.UPLOADED_FILE_MIME, attachment.mimeType)
        assertEquals(file.label, attachment.displayName)
        assertEquals(file, ComposerFiles.uploaded(attachment.privateUri, attachment.mimeType))
        assertNull(ComposerFiles.uploaded("/files/draft-attachments/x", "image/png"))
    }

    @Test
    fun `builds the desktop turn shape`() {
        val a = UploadedFile("spec.pdf", "/att/1/spec.pdf", "spec.pdf (12 pages)")
        val b = UploadedFile("log.txt", "/att/2/log.txt", "log.txt")
        val turn = ComposerFiles.turn("look", listOf(a, b))
        assertEquals(
            "look\n\n[Attached file \"spec.pdf\" is saved at: /att/1/spec.pdf]\n[Attached file \"log.txt\" is saved at: /att/2/log.txt]",
            turn.providerText,
        )
        assertEquals("look\n\n[[pill:${a.pillId}]]\n[[pill:${b.pillId}]]", turn.displayBody)
        assertEquals(mapOf(a.pillId to "spec.pdf (12 pages)", b.pillId to "log.txt"), turn.pillsMeta)
        assertEquals(a.pillId, UploadedFile("other", a.path, "other").pillId)

        val bare = ComposerFiles.turn("", listOf(a))
        assertEquals("[Attached file \"spec.pdf\" is saved at: /att/1/spec.pdf]", bare.providerText)
        assertEquals("[[pill:${a.pillId}]]", bare.displayBody)

        val plain = ComposerFiles.turn("hi", emptyList())
        assertEquals(FileAttachmentTurn("hi", "hi", emptyMap()), plain)
    }
}
