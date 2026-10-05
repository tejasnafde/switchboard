package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerImageSource
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import app.switchboard.mobile.domain.composer.ImageResizePlan
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateComposerAttachmentStagerTest {
    @Test
    fun `picked image is atomically copied into draft owned storage`() {
        val root = Files.createTempDirectory("sb-draft-stage").toFile()
        try {
            val stager = PrivateComposerAttachmentStager(
                rootDirectory = root,
                contentUris = ContentUriSource { ByteArrayInputStream(byteArrayOf(1, 2, 3)) },
                shrinker = { open, _ -> ShrinkResult.Shrunk(open().readBytes().reversedArray(), "image/jpeg") },
                fileNames = AttachmentFileNameSource { "draft-image" },
            )

            val result = stager.stage(
                listOf(ComposerImageSource("content://picked", "image/png", "picked.png")),
                emptyList(),
            ) as ComposerAttachmentStageResult.Success

            val staged = result.attachments.single()
            assertArrayEquals(byteArrayOf(3, 2, 1), File(staged.privateUri).readBytes())
            assertEquals("image/jpeg", staged.mimeType)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `discard refuses files outside the draft owned root`() {
        val root = Files.createTempDirectory("sb-draft-root").toFile()
        val outside = Files.createTempFile("sb-user-file", ".png").toFile()
        try {
            val inside = File(root, "inside").apply { writeBytes(byteArrayOf(1)) }
            val stager = PrivateComposerAttachmentStager(
                rootDirectory = root,
                contentUris = ContentUriSource { null },
                shrinker = { _, _ -> error("not called") },
            )

            stager.discard(
                listOf(
                    ComposerAttachment("inside", inside.absolutePath, null, "inside"),
                    ComposerAttachment("outside", outside.absolutePath, null, "outside"),
                ),
            )

            assertFalse(inside.exists())
            assertTrue(outside.exists())
        } finally {
            root.deleteRecursively()
            outside.delete()
        }
    }

    @Test
    fun `outbox owned edit source is copied without deleting the queued attachment`() {
        val draftRoot = Files.createTempDirectory("sb-draft-root").toFile()
        val outboxRoot = Files.createTempDirectory("sb-outbox-source").toFile()
        try {
            val source = File(outboxRoot, "queued-image").apply { writeBytes(byteArrayOf(5, 6)) }
            val stager = PrivateComposerAttachmentStager(
                rootDirectory = draftRoot,
                contentUris = ContentUriSource { null },
                shrinker = { _, _ -> error("an owned source is never shrunk again") },
                fileNames = AttachmentFileNameSource { "editable-copy" },
                ownedSourceRootDirectory = outboxRoot,
            )

            val result = stager.stage(
                listOf(
                    ComposerImageSource(
                        contentUri = "",
                        mimeType = "image/png",
                        displayName = "queued-image",
                        privateSourcePath = source.absolutePath,
                    ),
                ),
                emptyList(),
            ) as ComposerAttachmentStageResult.Success

            assertArrayEquals(byteArrayOf(5, 6), File(result.attachments.single().privateUri).readBytes())
            assertTrue(source.exists())
        } finally {
            draftRoot.deleteRecursively()
            outboxRoot.deleteRecursively()
        }
    }

    @Test
    fun `each image gets what is left of the budget and a refusal names the image`() {
        val root = Files.createTempDirectory("sb-draft-budget").toFile()
        try {
            val existing = File(root, "existing").apply { writeBytes(ByteArray(300)) }
            val budgets = mutableListOf<Long>()
            var next = 0
            val stager = PrivateComposerAttachmentStager(
                rootDirectory = root,
                contentUris = ContentUriSource { ByteArrayInputStream(byteArrayOf(1)) },
                shrinker = { _, remaining ->
                    budgets += remaining
                    if (budgets.size == 1) {
                        ShrinkResult.Shrunk(ByteArray(30), "image/jpeg")
                    } else {
                        ShrinkResult.Refused(ImageResizePlan.Refusal.OVER_MESSAGE_BUDGET)
                    }
                },
                fileNames = AttachmentFileNameSource { "staged-${next++}" },
            )

            val result = stager.stage(
                listOf(
                    ComposerImageSource("content://a", null, "a.jpg"),
                    ComposerImageSource("content://b", null, "b.jpg"),
                ),
                listOf(ComposerAttachment("existing", existing.absolutePath, "image/png", "existing")),
            ) as ComposerAttachmentStageResult.Success

            val afterExisting = ImageResizePlan.MESSAGE_WIRE_BUDGET - ImageResizePlan.dataUrlWireBytes("image/png", 300)
            assertEquals(
                listOf(afterExisting, afterExisting - ImageResizePlan.dataUrlWireBytes("image/jpeg", 30)),
                budgets,
            )
            assertEquals(1, result.attachments.size)
            assertEquals(
                listOf("b.jpg did not fit: the images in one message can total at most 3 MB"),
                result.refused,
            )
        } finally {
            root.deleteRecursively()
        }
    }
}
