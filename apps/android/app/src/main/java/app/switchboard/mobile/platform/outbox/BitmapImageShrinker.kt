package app.switchboard.mobile.platform.outbox

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import androidx.core.graphics.createBitmap
import androidx.exifinterface.media.ExifInterface
import app.switchboard.mobile.domain.composer.ImageResizePlan
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * Shrinks a picked image with BitmapFactory. Decodes with `inSampleSize` so a
 * 50 MP photo never decodes at full size, applies the EXIF orientation, and
 * re-encodes without EXIF. Runs on the composer runtime's worker thread.
 */
class BitmapImageShrinker : ComposerImageShrinker {
    override fun shrink(open: () -> InputStream, remainingWireBytes: Long): ShrinkResult {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            return ShrinkResult.Refused(ImageResizePlan.Refusal.UNREADABLE)
        }
        val sourceType = bounds.outMimeType ?: "image/jpeg"
        val attempts = ImageResizePlan.attempts(sourceType) ?: return sendAsIs(open, sourceType, remainingWireBytes)
        val orientation = ImageResizePlan.orientation(
            open().use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) },
        )
        val decodeOptions = BitmapFactory.Options().apply {
            inSampleSize = ImageResizePlan.sampleSize(bounds.outWidth, bounds.outHeight, attempts.first().maxSide)
        }
        val decoded = open().use { BitmapFactory.decodeStream(it, null, decodeOptions) }
            ?: return ShrinkResult.Refused(ImageResizePlan.Refusal.UNREADABLE)
        try {
            val outcome = ImageResizePlan.shrink(attempts, remainingWireBytes) { attempt ->
                val bytes = encode(decoded, orientation, attempt)
                bytes to ImageResizePlan.dataUrlWireBytes(attempt.format.mimeType, bytes.size.toLong())
            }
            return when (outcome) {
                is ImageResizePlan.Outcome.Fitted -> ShrinkResult.Shrunk(outcome.result, outcome.attempt.format.mimeType)
                is ImageResizePlan.Outcome.Refused -> ShrinkResult.Refused(outcome.reason)
            }
        } finally {
            decoded.recycle()
        }
    }

    private fun sendAsIs(open: () -> InputStream, mimeType: String, remaining: Long): ShrinkResult {
        // Read no more than could fit, so a huge GIF is refused without loading it.
        val limit = ImageResizePlan.MESSAGE_WIRE_BUDGET * 3 / 4 + 1
        val bytes = open().use { input -> ByteArray(limit.toInt()).let { it.copyOf(input.readUpTo(it)) } }
        val refusal = ImageResizePlan.sendAsIs(ImageResizePlan.dataUrlWireBytes(mimeType, bytes.size.toLong()), remaining)
        return refusal?.let(ShrinkResult::Refused) ?: ShrinkResult.Shrunk(bytes, mimeType)
    }

    private fun InputStream.readUpTo(buffer: ByteArray): Int {
        var total = 0
        while (total < buffer.size) {
            val read = read(buffer, total, buffer.size - total)
            if (read < 0) break
            total += read
        }
        return total
    }

    private fun encode(
        source: Bitmap,
        orientation: ImageResizePlan.Orientation,
        attempt: ImageResizePlan.Attempt,
    ): ByteArray {
        val uprightWidth = if (orientation.swapsSides) source.height else source.width
        val uprightHeight = if (orientation.swapsSides) source.width else source.height
        val target = ImageResizePlan.fitWithin(uprightWidth, uprightHeight, attempt.maxSide)
        val output = createBitmap(target.width, target.height)
        try {
            val canvas = Canvas(output)
            // JPEG has no alpha: a transparent pixel would otherwise turn black.
            if (attempt.format == ImageResizePlan.Format.JPEG) canvas.drawColor(Color.WHITE)
            val matrix = Matrix().apply {
                postTranslate(-source.width / 2f, -source.height / 2f)
                postRotate(orientation.rotateDegrees.toFloat())
                if (orientation.mirror) postScale(-1f, 1f)
                postScale(target.width / uprightWidth.toFloat(), target.height / uprightHeight.toFloat())
                postTranslate(target.width / 2f, target.height / 2f)
            }
            canvas.drawBitmap(source, matrix, Paint(Paint.FILTER_BITMAP_FLAG))
            return ByteArrayOutputStream().use { stream ->
                val format = if (attempt.format == ImageResizePlan.Format.PNG) {
                    Bitmap.CompressFormat.PNG
                } else {
                    Bitmap.CompressFormat.JPEG
                }
                output.compress(format, attempt.quality, stream)
                stream.toByteArray()
            }
        } finally {
            output.recycle()
        }
    }
}
