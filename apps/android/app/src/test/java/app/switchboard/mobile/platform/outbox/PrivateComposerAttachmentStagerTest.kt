package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerImageSource
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
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
                fileNames = AttachmentFileNameSource { "draft-image" },
            )

            val result = stager.stage(
                listOf(ComposerImageSource("content://picked", "image/png", "picked.png")),
            ) as ComposerAttachmentStageResult.Success

            assertArrayEquals(byteArrayOf(1, 2, 3), File(result.attachments.single().privateUri).readBytes())
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
            ) as ComposerAttachmentStageResult.Success

            assertArrayEquals(byteArrayOf(5, 6), File(result.attachments.single().privateUri).readBytes())
            assertTrue(source.exists())
        } finally {
            draftRoot.deleteRecursively()
            outboxRoot.deleteRecursively()
        }
    }
}
