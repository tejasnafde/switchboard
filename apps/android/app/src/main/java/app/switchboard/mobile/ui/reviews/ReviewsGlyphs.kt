package app.switchboard.mobile.ui.reviews

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.domain.reviews.PhonePrTone
import app.switchboard.mobile.domain.reviews.PrRowIcon
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.TextDim

/**
 * The Reviews glyphs, drawn rather than taken from an icon set: the app ships
 * only material-icons-core, which has no eye, merge or pull request shape.
 */
enum class ReviewsGlyph { Failed, Review, Ready, Running, Waiting, Draft, Conflict, Conversation, Merged, PullRequest, Filter, External, Lock }

fun PrRowIcon.glyph(): ReviewsGlyph = when (this) {
    PrRowIcon.Failed -> ReviewsGlyph.Failed
    PrRowIcon.Review -> ReviewsGlyph.Review
    PrRowIcon.Ready -> ReviewsGlyph.Ready
    PrRowIcon.Running -> ReviewsGlyph.Running
    PrRowIcon.Waiting -> ReviewsGlyph.Waiting
    PrRowIcon.Draft -> ReviewsGlyph.Draft
    PrRowIcon.Conflict -> ReviewsGlyph.Conflict
    PrRowIcon.Conversation -> ReviewsGlyph.Conversation
    PrRowIcon.Merged -> ReviewsGlyph.Merged
}

fun PrRowIcon.tint(): Color = when (this) {
    PrRowIcon.Failed, PrRowIcon.Conflict -> Red
    PrRowIcon.Review, PrRowIcon.Merged -> Accent
    PrRowIcon.Ready -> Green
    PrRowIcon.Running, PrRowIcon.Conversation -> Amber
    PrRowIcon.Waiting, PrRowIcon.Draft -> TextDim
}

fun PhonePrTone.color(): Color = when (this) {
    PhonePrTone.Failure -> Red
    PhonePrTone.Pending -> Amber
    PhonePrTone.Success -> Green
    PhonePrTone.Dim -> TextDim
}

/** The glyph a status line leads with: a cross, a running ring, a check or an empty ring. */
fun PhonePrTone.glyph(): ReviewsGlyph = when (this) {
    PhonePrTone.Failure -> ReviewsGlyph.Failed
    PhonePrTone.Pending -> ReviewsGlyph.Running
    PhonePrTone.Success -> ReviewsGlyph.Ready
    PhonePrTone.Dim -> ReviewsGlyph.Waiting
}

/** A check's state as a row glyph. */
fun checkGlyph(state: String): Pair<ReviewsGlyph, Color> = when (state) {
    "failure" -> ReviewsGlyph.Failed to Red
    "pending" -> ReviewsGlyph.Running to Amber
    "success" -> ReviewsGlyph.Ready to Green
    else -> ReviewsGlyph.Draft to TextDim
}

@Composable
fun ReviewsGlyphIcon(glyph: ReviewsGlyph, tint: Color, modifier: Modifier = Modifier, size: Dp = 18.dp) {
    Canvas(modifier = modifier.size(size).clearAndSetSemantics {}) { drawGlyph(glyph, tint) }
}

private fun DrawScope.drawGlyph(glyph: ReviewsGlyph, tint: Color) {
    val w = size.minDimension
    val stroke = Stroke(width = w * 0.1f, cap = StrokeCap.Round)
    val c = center
    val r = w * 0.4f
    fun line(x1: Float, y1: Float, x2: Float, y2: Float) =
        drawLine(tint, Offset(x1 * w, y1 * w), Offset(x2 * w, y2 * w), strokeWidth = stroke.width, cap = StrokeCap.Round)
    when (glyph) {
        ReviewsGlyph.Failed -> {
            drawCircle(tint, r, c, style = stroke)
            line(0.36f, 0.36f, 0.64f, 0.64f)
            line(0.64f, 0.36f, 0.36f, 0.64f)
        }
        ReviewsGlyph.Review -> {
            val eye = Path().apply {
                moveTo(0.08f * w, 0.5f * w)
                quadraticTo(0.5f * w, 0.08f * w, 0.92f * w, 0.5f * w)
                quadraticTo(0.5f * w, 0.92f * w, 0.08f * w, 0.5f * w)
                close()
            }
            drawPath(eye, tint, style = stroke)
            drawCircle(tint, w * 0.11f, c)
        }
        ReviewsGlyph.Ready -> {
            drawCircle(tint, r, c, style = stroke)
            line(0.33f, 0.52f, 0.45f, 0.64f)
            line(0.45f, 0.64f, 0.68f, 0.38f)
        }
        ReviewsGlyph.Running -> {
            drawCircle(tint, r, c, style = Stroke(stroke.width, pathEffect = PathEffect.dashPathEffect(floatArrayOf(w * 0.12f, w * 0.1f))))
            drawCircle(tint, w * 0.1f, c)
        }
        ReviewsGlyph.Waiting -> {
            drawCircle(tint, r, c, style = stroke)
            line(0.5f, 0.3f, 0.5f, 0.5f)
            line(0.5f, 0.5f, 0.64f, 0.6f)
        }
        ReviewsGlyph.Draft -> drawCircle(
            tint,
            r,
            c,
            style = Stroke(stroke.width, pathEffect = PathEffect.dashPathEffect(floatArrayOf(w * 0.06f, w * 0.1f))),
        )
        ReviewsGlyph.Conflict -> {
            val triangle = Path().apply {
                moveTo(0.5f * w, 0.12f * w)
                lineTo(0.92f * w, 0.86f * w)
                lineTo(0.08f * w, 0.86f * w)
                close()
            }
            drawPath(triangle, tint, style = stroke)
            line(0.5f, 0.4f, 0.5f, 0.6f)
            drawCircle(tint, w * 0.05f, Offset(0.5f * w, 0.73f * w))
        }
        ReviewsGlyph.Conversation -> {
            drawRoundRect(
                tint,
                topLeft = Offset(0.1f * w, 0.14f * w),
                size = Size(0.8f * w, 0.56f * w),
                cornerRadius = CornerRadius(0.1f * w),
                style = stroke,
            )
            line(0.3f, 0.7f, 0.3f, 0.88f)
        }
        ReviewsGlyph.Merged, ReviewsGlyph.PullRequest -> {
            drawCircle(tint, w * 0.11f, Offset(0.28f * w, 0.2f * w), style = stroke)
            drawCircle(tint, w * 0.11f, Offset(0.28f * w, 0.8f * w), style = stroke)
            drawCircle(tint, w * 0.11f, Offset(0.74f * w, 0.8f * w), style = stroke)
            line(0.28f, 0.31f, 0.28f, 0.69f)
            if (glyph == ReviewsGlyph.Merged) {
                line(0.3f, 0.32f, 0.72f, 0.69f)
            } else {
                line(0.74f, 0.69f, 0.74f, 0.32f)
                line(0.74f, 0.32f, 0.5f, 0.2f)
            }
        }
        ReviewsGlyph.Filter -> {
            line(0.15f, 0.28f, 0.85f, 0.28f)
            line(0.28f, 0.5f, 0.72f, 0.5f)
            line(0.4f, 0.72f, 0.6f, 0.72f)
        }
        ReviewsGlyph.External -> {
            line(0.42f, 0.2f, 0.2f, 0.2f)
            line(0.2f, 0.2f, 0.2f, 0.8f)
            line(0.2f, 0.8f, 0.8f, 0.8f)
            line(0.8f, 0.8f, 0.8f, 0.58f)
            line(0.5f, 0.5f, 0.82f, 0.18f)
            line(0.58f, 0.18f, 0.82f, 0.18f)
            line(0.82f, 0.18f, 0.82f, 0.42f)
        }
        ReviewsGlyph.Lock -> {
            drawRoundRect(
                tint,
                topLeft = Offset(0.2f * w, 0.44f * w),
                size = Size(0.6f * w, 0.44f * w),
                cornerRadius = CornerRadius(0.06f * w),
                style = stroke,
            )
            drawArc(
                tint,
                startAngle = 180f,
                sweepAngle = 180f,
                useCenter = false,
                topLeft = Offset(0.32f * w, 0.14f * w),
                size = Size(0.36f * w, 0.4f * w),
                style = stroke,
            )
        }
    }
}
