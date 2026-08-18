package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.data.composer.ComposerAttachmentStager
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerImageSource
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID

class PrivateComposerAttachmentStager(
    rootDirectory: File,
    private val contentUris: ContentUriSource,
    private val fileNames: AttachmentFileNameSource = AttachmentFileNameSource {
        UUID.randomUUID().toString()
    },
    ownedSourceRootDirectory: File? = null,
) : ComposerAttachmentStager {
    private val root = rootDirectory.absoluteFile
    private val ownedSourceRoot = ownedSourceRootDirectory?.absoluteFile

    override fun stage(sources: List<ComposerImageSource>): ComposerAttachmentStageResult {
        if (sources.isEmpty()) return ComposerAttachmentStageResult.Success(emptyList())
        val staged = mutableListOf<ComposerAttachment>()
        val temporaryFiles = mutableListOf<File>()
        return try {
            require((root.isDirectory || root.mkdirs()) && root.isDirectory) {
                "draft attachment directory is unavailable"
            }
            sources.forEach { source ->
                val name = fileNames.nextName()
                require(name.isSafeFileName()) { "draft attachment file name is unsafe" }
                val target = File(root, name)
                require(!target.exists()) { "draft attachment target already exists" }
                val temporary = createTemporaryFile(name).also(temporaryFiles::add)
                val input = source.privateSourcePath?.let(::openOwnedSource)
                    ?: run {
                        require(source.contentUri.startsWith("content://")) {
                            "draft attachment source must be a content URI"
                        }
                        contentUris.open(source.contentUri)
                            ?: error("content URI could not be opened")
                    }
                input.use { opened ->
                    FileOutputStream(temporary).use { output ->
                        opened.copyTo(output)
                        output.fd.sync()
                    }
                }
                require(temporary.renameTo(target)) { "draft attachment could not be installed" }
                temporaryFiles.remove(temporary)
                staged += ComposerAttachment(
                    id = name,
                    privateUri = target.absolutePath,
                    mimeType = source.mimeType,
                    displayName = source.displayName,
                )
            }
            ComposerAttachmentStageResult.Success(staged)
        } catch (exception: Exception) {
            temporaryFiles.forEach(File::delete)
            discard(staged)
            ComposerAttachmentStageResult.Failure(
                exception.message ?: "draft attachment staging failed",
            )
        }
    }

    override fun discard(attachments: List<ComposerAttachment>) {
        attachments.forEach { attachment ->
            runCatching {
                val file = File(attachment.privateUri).absoluteFile
                if (file.parentFile?.canonicalFile == root.canonicalFile) file.delete()
            }
        }
    }

    private fun openOwnedSource(path: String): FileInputStream {
        val allowedRoot = requireNotNull(ownedSourceRoot) {
            "private edit attachment sources are unavailable"
        }
        val source = File(path).absoluteFile
        require(source.parentFile?.canonicalFile == allowedRoot.canonicalFile) {
            "private edit attachment source is outside app-owned outbox storage"
        }
        return FileInputStream(source)
    }

    private fun createTemporaryFile(name: String): File {
        repeat(4) {
            val candidate = File(root, ".$name.${UUID.randomUUID()}.tmp")
            if (candidate.createNewFile()) return candidate
        }
        error("draft attachment temporary file could not be created")
    }

    private fun String.isSafeFileName(): Boolean =
        isNotBlank() && this != "." && this != ".." && all { character ->
            character.isLetterOrDigit() || character == '-' || character == '_' || character == '.'
        }
}
