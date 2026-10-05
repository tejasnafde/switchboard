package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.data.composer.ComposerAttachmentStager
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.composer.ImageResizePlan
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID
import android.util.Log

sealed interface ShrinkResult {
    class Shrunk(val bytes: ByteArray, val mimeType: String) : ShrinkResult
    data class Refused(val reason: ImageResizePlan.Refusal) : ShrinkResult
}

/** Scales and re-encodes one picked image to fit [remainingWireBytes] of the message. */
fun interface ComposerImageShrinker {
    fun shrink(open: () -> InputStream, remainingWireBytes: Long): ShrinkResult
}

class PrivateComposerAttachmentStager(
    rootDirectory: File,
    private val contentUris: ContentUriSource,
    private val shrinker: ComposerImageShrinker,
    private val fileNames: AttachmentFileNameSource = AttachmentFileNameSource {
        UUID.randomUUID().toString()
    },
    ownedSourceRootDirectory: File? = null,
) : ComposerAttachmentStager {
    private val root = rootDirectory.absoluteFile
    private val ownedSourceRoot = ownedSourceRootDirectory?.absoluteFile

    override fun stage(
        sources: List<ComposerImageSource>,
        existing: List<ComposerAttachment>,
    ): ComposerAttachmentStageResult {
        if (sources.isEmpty()) return ComposerAttachmentStageResult.Success(emptyList())
        val staged = mutableListOf<ComposerAttachment>()
        val refused = mutableListOf<String>()
        val temporaryFiles = mutableListOf<File>()
        var remaining = ImageResizePlan.MESSAGE_WIRE_BUDGET - existing.sumOf(::wireBytesOf)
        return try {
            require((root.isDirectory || root.mkdirs()) && root.isDirectory) {
                "draft attachment directory is unavailable"
            }
            sources.forEach { source ->
                // A queued message's own images were shrunk when they were picked.
                val shrunk = if (source.privateSourcePath != null) {
                    ShrinkResult.Shrunk(openOwnedSource(source.privateSourcePath).use { it.readBytes() }, source.mimeType.orEmpty())
                } else {
                    require(source.contentUri.startsWith("content://")) {
                        "draft attachment source must be a content URI"
                    }
                    shrinkPicked(source, remaining)
                }
                if (shrunk is ShrinkResult.Refused) {
                    refused += ImageResizePlan.refusalMessage(source.displayName, shrunk.reason)
                    return@forEach
                }
                shrunk as ShrinkResult.Shrunk
                val name = fileNames.nextName()
                require(name.isSafeFileName()) { "draft attachment file name is unsafe" }
                val target = File(root, name)
                require(!target.exists()) { "draft attachment target already exists" }
                val temporary = createTemporaryFile(name).also(temporaryFiles::add)
                FileOutputStream(temporary).use { output ->
                    output.write(shrunk.bytes)
                    output.fd.sync()
                }
                require(temporary.renameTo(target)) { "draft attachment could not be installed" }
                temporaryFiles.remove(temporary)
                val mimeType = shrunk.mimeType.ifEmpty { null }
                remaining -= ImageResizePlan.dataUrlWireBytes(mimeType ?: "", shrunk.bytes.size.toLong())
                staged += ComposerAttachment(
                    id = name,
                    privateUri = target.absolutePath,
                    mimeType = mimeType,
                    displayName = source.displayName,
                )
            }
            ComposerAttachmentStageResult.Success(staged, refused)
        } catch (exception: Exception) {
            temporaryFiles.forEach(File::delete)
            discard(staged)
            ComposerAttachmentStageResult.Failure(
                exception.message ?: "draft attachment staging failed",
            )
        }
    }

    private fun shrinkPicked(source: ComposerImageSource, remaining: Long): ShrinkResult = try {
        shrinker.shrink(
            open = { contentUris.open(source.contentUri) ?: error("content URI could not be opened") },
            remainingWireBytes = remaining,
        )
    } catch (exception: Exception) {
        Log.w(TAG, "image resize failed for ${source.displayName}", exception)
        ShrinkResult.Refused(ImageResizePlan.Refusal.UNREADABLE)
    } catch (error: OutOfMemoryError) {
        Log.w(TAG, "image resize ran out of memory for ${source.displayName}", error)
        ShrinkResult.Refused(ImageResizePlan.Refusal.UNREADABLE)
    }

    private fun wireBytesOf(attachment: ComposerAttachment): Long =
        ImageResizePlan.dataUrlWireBytes(attachment.mimeType ?: "", File(attachment.privateUri).length())

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

    private companion object {
        const val TAG = "ComposerAttachments"
    }
}
