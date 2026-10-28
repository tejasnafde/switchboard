package app.switchboard.mobile.platform.outbox

import android.util.Log
import app.switchboard.mobile.data.composer.ComposerFileUploader
import app.switchboard.mobile.data.composer.ComposerUploadResult
import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.composer.ComposerFiles
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.composer.UploadedFile
import app.switchboard.mobile.domain.remote.RemoteOutcome
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * Reads a picked file (at most [ComposerFiles.MAX_UPLOAD_BYTES]) and sends
 * its bytes over `app:upload-attachment`. Runs on the composer worker; the
 * callback comes from the transport.
 */
@OptIn(ExperimentalEncodingApi::class)
class RemoteComposerFileUploader(
    private val client: SwitchboardRemoteClient,
    private val contentUris: ContentUriSource,
) : ComposerFileUploader {
    override fun upload(source: ComposerImageSource, callback: (ComposerUploadResult) -> Unit) {
        val name = source.displayName
        val bytes = try {
            contentUris.open(source.contentUri)?.use(::readBounded) ?: error("content URI could not be opened")
        } catch (exception: Exception) {
            Log.w(TAG, "attachment could not be read", exception)
            return callback(ComposerUploadResult.Refused(ComposerFiles.refusal(name, "It could not be read.")))
        }
        if (bytes.size > ComposerFiles.MAX_UPLOAD_BYTES) {
            return callback(ComposerUploadResult.Refused(ComposerFiles.tooLarge(name, bytes.size.toLong())))
        }
        send(name, bytes, lines = null, callback)
    }

    override fun uploadText(name: String, text: String, callback: (ComposerUploadResult) -> Unit) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size > ComposerFiles.MAX_UPLOAD_BYTES) {
            return callback(ComposerUploadResult.Refused(ComposerFiles.tooLarge(name, bytes.size.toLong())))
        }
        send(name, bytes, lines = ComposerFiles.lineCount(text), callback)
    }

    private fun send(name: String, bytes: ByteArray, lines: Int?, callback: (ComposerUploadResult) -> Unit) {
        client.uploadAttachment(name, Base64.encode(bytes)) { response ->
            callback(
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> ComposerUploadResult.Uploaded(
                        UploadedFile(
                            name = name,
                            path = outcome.value.path,
                            label = ComposerFiles.label(name, pages = outcome.value.pages, lines = lines),
                            savedAtMs = System.currentTimeMillis(),
                        ),
                    )
                    is RemoteOutcome.Failure -> {
                        Log.w(TAG, "attachment upload failed: ${outcome.message}")
                        ComposerUploadResult.Refused(ComposerFiles.refusal(name, "It could not be saved."))
                    }
                },
            )
        }
    }

    /** One byte over the limit is enough to refuse, so a huge file is never read whole. */
    private fun readBounded(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (output.size() <= ComposerFiles.MAX_UPLOAD_BYTES) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private companion object {
        const val TAG = "ComposerUploads"
    }
}
