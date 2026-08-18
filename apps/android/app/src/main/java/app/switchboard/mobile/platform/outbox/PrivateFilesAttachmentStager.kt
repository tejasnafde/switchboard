package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.outbox.AttachmentStageResult
import app.switchboard.mobile.data.outbox.AttachmentStager
import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.StagedAttachment
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID

fun interface ContentUriSource {
    fun open(uri: String): InputStream?
}

fun interface AttachmentFileNameSource {
    fun nextName(): String
}

class PrivateFilesAttachmentStager(
    rootDirectory: File,
    private val contentUris: ContentUriSource,
    private val fileNames: AttachmentFileNameSource = AttachmentFileNameSource {
        UUID.randomUUID().toString()
    },
) : AttachmentStager {
    private val root = rootDirectory.absoluteFile

    override fun stage(attachments: List<AttachmentDraft>): AttachmentStageResult {
        if (attachments.isEmpty()) return AttachmentStageResult.Success(emptyList())
        val staged = mutableListOf<StagedAttachment>()
        val temporaryFiles = mutableListOf<File>()
        return try {
            ensurePrivateDirectory()
            attachments.forEach { draft ->
                require(draft.sourceUri.startsWith(CONTENT_URI_PREFIX)) {
                    "attachment source must be a content URI"
                }
                val name = fileNames.nextName()
                require(name.isSafeFileName()) { "attachment file name is unsafe" }
                val target = File(root, name)
                require(!target.exists()) { "attachment target already exists" }
                val temporary = createTemporaryFile(name).also(temporaryFiles::add)

                val input = contentUris.open(draft.sourceUri)
                    ?: error("content URI could not be opened")
                input.use { source ->
                    FileOutputStream(temporary).use { sink ->
                        source.copyTo(sink)
                        sink.fd.sync()
                    }
                }
                require(temporary.renameTo(target)) { "attachment could not be atomically installed" }
                temporaryFiles.remove(temporary)
                staged += StagedAttachment(target.absolutePath, draft.mimeType)
            }
            AttachmentStageResult.Success(staged)
        } catch (exception: Exception) {
            temporaryFiles.forEach(File::delete)
            discard(staged)
            AttachmentStageResult.Failure(exception.message ?: "attachment staging failed")
        }
    }

    override fun discard(attachments: List<StagedAttachment>) {
        attachments.forEach { attachment ->
            runCatching {
                val file = File(attachment.privateUri).absoluteFile
                if (file.parentFile?.canonicalFile == root.canonicalFile) file.delete()
            }
        }
    }

    private fun ensurePrivateDirectory() {
        require((root.isDirectory || root.mkdirs()) && root.isDirectory) {
            "private attachment directory is unavailable"
        }
    }

    private fun createTemporaryFile(name: String): File {
        repeat(MAX_TEMP_FILE_ATTEMPTS) {
            val candidate = File(root, ".$name.${UUID.randomUUID()}.tmp")
            if (candidate.createNewFile()) return candidate
        }
        error("attachment temporary file could not be created")
    }

    private fun String.isSafeFileName(): Boolean =
        isNotBlank() && this != "." && this != ".." && all { character ->
            character.isLetterOrDigit() || character == '-' || character == '_' || character == '.'
        }

    private companion object {
        const val CONTENT_URI_PREFIX = "content://"
        const val MAX_TEMP_FILE_ATTEMPTS = 4
    }
}
