package app.switchboard.mobile.platform.outbox

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import app.switchboard.mobile.data.outbox.AttachmentStageResult
import app.switchboard.mobile.data.outbox.AttachmentStager
import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.StagedAttachment
import java.io.File

class AndroidContentUriSource(
    private val resolver: ContentResolver,
) : ContentUriSource {
    override fun open(uri: String) = resolver.openInputStream(Uri.parse(uri))
}

class AndroidPrivateFilesAttachmentStager(
    context: Context,
) : AttachmentStager {
    private val delegate = PrivateFilesAttachmentStager(
        rootDirectory = File(context.filesDir, ATTACHMENT_DIRECTORY),
        contentUris = AndroidContentUriSource(context.contentResolver),
        ownedSourceRootDirectory = File(
            context.filesDir,
            AndroidComposerAttachmentStager.DRAFT_ATTACHMENT_DIRECTORY,
        ),
    )

    override fun stage(attachments: List<AttachmentDraft>): AttachmentStageResult =
        delegate.stage(attachments)

    override fun discard(attachments: List<StagedAttachment>) {
        delegate.discard(attachments)
    }

    companion object {
        const val ATTACHMENT_DIRECTORY = "outbox-attachments"
    }
}
