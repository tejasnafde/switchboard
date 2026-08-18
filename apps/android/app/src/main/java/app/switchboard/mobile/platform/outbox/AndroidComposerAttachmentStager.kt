package app.switchboard.mobile.platform.outbox

import android.content.Context
import app.switchboard.mobile.data.composer.ComposerAttachmentStageResult
import app.switchboard.mobile.data.composer.ComposerAttachmentStager
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerImageSource
import java.io.File

class AndroidComposerAttachmentStager(context: Context) : ComposerAttachmentStager {
    private val delegate = PrivateComposerAttachmentStager(
        rootDirectory = File(context.filesDir, DRAFT_ATTACHMENT_DIRECTORY),
        contentUris = AndroidContentUriSource(context.contentResolver),
        ownedSourceRootDirectory = File(
            context.filesDir,
            AndroidPrivateFilesAttachmentStager.ATTACHMENT_DIRECTORY,
        ),
    )

    override fun stage(sources: List<ComposerImageSource>): ComposerAttachmentStageResult =
        delegate.stage(sources)

    override fun discard(attachments: List<ComposerAttachment>) = delegate.discard(attachments)

    companion object {
        const val DRAFT_ATTACHMENT_DIRECTORY = "draft-attachments"
    }
}
