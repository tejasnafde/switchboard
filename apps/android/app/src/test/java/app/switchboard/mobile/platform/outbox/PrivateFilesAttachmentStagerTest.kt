package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.outbox.AttachmentStageResult
import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.StagedAttachment
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateFilesAttachmentStagerTest {
    @Test
    fun copiesContentUriIntoPrivateStorageViaTempRename() {
        val root = Files.createTempDirectory("sb-stager").toFile()
        try {
            val bytes = byteArrayOf(1, 2, 3, 4)
            val stager = PrivateFilesAttachmentStager(
                rootDirectory = root,
                contentUris = ContentUriSource { uri ->
                    check(uri == "content://photos/one")
                    ByteArrayInputStream(bytes)
                },
                fileNames = AttachmentFileNameSource { "stable-name" },
            )

            val result = stager.stage(listOf(AttachmentDraft("content://photos/one", "image/png")))

            assertTrue(result is AttachmentStageResult.Success)
            val attachment = (result as AttachmentStageResult.Success).attachments.single()
            assertEquals("image/png", attachment.mimeType)
            assertArrayEquals(bytes, File(attachment.privateUri).readBytes())
            assertEquals(listOf("stable-name"), root.list()?.toList())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun failedBatchRemovesCompletedFilesAndTemporaryFiles() {
        val root = Files.createTempDirectory("sb-stager-fail").toFile()
        try {
            val names = ArrayDeque(listOf("first", "second"))
            val stager = PrivateFilesAttachmentStager(
                rootDirectory = root,
                contentUris = ContentUriSource { uri ->
                    if (uri.endsWith("bad")) throw FileNotFoundException(uri)
                    ByteArrayInputStream(byteArrayOf(7))
                },
                fileNames = AttachmentFileNameSource { names.removeAt(0) },
            )

            val result = stager.stage(
                listOf(
                    AttachmentDraft("content://one", null),
                    AttachmentDraft("content://bad", null),
                ),
            )

            assertTrue(result is AttachmentStageResult.Failure)
            assertTrue(root.listFiles().orEmpty().isEmpty())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun existingTargetIsNeverOverwritten() {
        val root = Files.createTempDirectory("sb-stager-collision").toFile()
        try {
            val existing = File(root, "same").apply { writeText("keep") }
            val stager = PrivateFilesAttachmentStager(
                rootDirectory = root,
                contentUris = ContentUriSource { ByteArrayInputStream("new".toByteArray()) },
                fileNames = AttachmentFileNameSource { "same" },
            )

            assertTrue(stager.stage(listOf(AttachmentDraft("content://one", null))) is AttachmentStageResult.Failure)
            assertEquals("keep", existing.readText())
            assertEquals(listOf("same"), root.list()?.toList())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun discardDeletesOnlyFilesContainedByThePrivateRoot() {
        val root = Files.createTempDirectory("sb-stager-discard").toFile()
        val outside = Files.createTempFile("sb-outside", ".txt").toFile().apply { writeText("keep") }
        try {
            val inside = File(root, "inside").apply { writeText("remove") }
            val stager = PrivateFilesAttachmentStager(
                rootDirectory = root,
                contentUris = ContentUriSource { ByteArrayInputStream(byteArrayOf()) },
            )

            stager.discard(
                listOf(
                    StagedAttachment(inside.absolutePath, null),
                    StagedAttachment(outside.absolutePath, null),
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
    fun `draft owned source is copied into outbox ownership without deleting the source`() {
        val outboxRoot = Files.createTempDirectory("sb-outbox-root").toFile()
        val draftRoot = Files.createTempDirectory("sb-draft-source").toFile()
        try {
            val source = File(draftRoot, "draft-image").apply { writeBytes(byteArrayOf(8, 9)) }
            val stager = PrivateFilesAttachmentStager(
                rootDirectory = outboxRoot,
                contentUris = ContentUriSource { null },
                fileNames = AttachmentFileNameSource { "outbox-image" },
                ownedSourceRootDirectory = draftRoot,
            )

            val result = stager.stage(
                listOf(AttachmentDraft("", "image/png", source.absolutePath)),
            ) as AttachmentStageResult.Success

            assertArrayEquals(byteArrayOf(8, 9), File(result.attachments.single().privateUri).readBytes())
            assertTrue(source.exists())
        } finally {
            outboxRoot.deleteRecursively()
            draftRoot.deleteRecursively()
        }
    }
}
