package app.switchboard.mobile.domain.composer

/**
 * How an attached image is shrunk to fit the 3 MiB message limit. Port of
 * `src/shared/image-resize.ts`; keep the numbers and the copy in step.
 */
object ImageResizePlan {
    const val MESSAGE_WIRE_BUDGET = 3L * 1024 * 1024
    const val PNG_KEEP_WIRE_BYTES = 1024L * 1024

    enum class Format(val mimeType: String) { JPEG("image/jpeg"), PNG("image/png") }

    data class Attempt(val maxSide: Int, val quality: Int, val format: Format)

    /** Tried in order until one fits: full size first, then smaller and softer. */
    val JPEG_STEPS = listOf(
        Attempt(2048, 85, Format.JPEG),
        Attempt(1600, 85, Format.JPEG),
        Attempt(1280, 75, Format.JPEG),
    )

    /** Null for a GIF: re-encoding would drop its animation, so it is sent as is or refused. */
    fun attempts(sourceMimeType: String): List<Attempt>? = when (sourceMimeType) {
        "image/gif" -> null
        "image/png" -> listOf(Attempt(2048, 100, Format.PNG)) + JPEG_STEPS
        else -> JPEG_STEPS
    }

    data class Size(val width: Int, val height: Int)

    /** At most [maxSide] on the long side, keeping the aspect ratio. Never upscales. */
    fun fitWithin(width: Int, height: Int, maxSide: Int): Size {
        val longest = maxOf(width, height)
        if (width <= 0 || height <= 0 || longest <= maxSide) return Size(width, height)
        val ratio = maxSide.toDouble() / longest
        return Size(
            maxOf(1, Math.round(width * ratio).toInt()),
            maxOf(1, Math.round(height * ratio).toInt()),
        )
    }

    /**
     * Largest power-of-two `inSampleSize` that still decodes at least [maxSide]
     * on the long side, so a 50 MP photo never decodes at full size.
     */
    fun sampleSize(width: Int, height: Int, maxSide: Int): Int {
        val longest = maxOf(width, height)
        var sample = 1
        while (longest / (sample * 2) >= maxSide) sample *= 2
        return sample
    }

    fun dataUrlWireBytes(mimeType: String, byteLength: Long): Long =
        "data:$mimeType;base64,".length + 4 * ((byteLength + 2) / 3)

    fun attemptFits(attempt: Attempt, wireBytes: Long, remaining: Long): Boolean {
        val ceiling = if (attempt.format == Format.PNG) minOf(PNG_KEEP_WIRE_BYTES, remaining) else remaining
        return wireBytes <= ceiling
    }

    enum class Refusal { TOO_LARGE, OVER_MESSAGE_BUDGET, GIF_TOO_LARGE, UNREADABLE, UNSUPPORTED_TYPE }

    sealed interface Outcome<out T> {
        data class Fitted<T>(val result: T, val attempt: Attempt) : Outcome<T>
        data class Refused(val reason: Refusal) : Outcome<Nothing>
    }

    /** Try each attempt until one fits [remaining]; [encode] returns the result and its wire bytes. */
    fun <T> shrink(attempts: List<Attempt>, remaining: Long, encode: (Attempt) -> Pair<T, Long>): Outcome<T> {
        var smallest = Long.MAX_VALUE
        for (attempt in attempts) {
            val (result, wireBytes) = encode(attempt)
            if (attemptFits(attempt, wireBytes, remaining)) return Outcome.Fitted(result, attempt)
            if (attempt.format == Format.JPEG) smallest = minOf(smallest, wireBytes)
        }
        return Outcome.Refused(
            if (smallest <= MESSAGE_WIRE_BUDGET) Refusal.OVER_MESSAGE_BUDGET else Refusal.TOO_LARGE,
        )
    }

    /** A GIF fits what is left, or is refused with the reason. */
    fun sendAsIs(wireBytes: Long, remaining: Long): Refusal? = when {
        wireBytes <= remaining -> null
        wireBytes <= MESSAGE_WIRE_BUDGET -> Refusal.OVER_MESSAGE_BUDGET
        else -> Refusal.GIF_TOO_LARGE
    }

    fun refusalMessage(name: String, reason: Refusal): String = when (reason) {
        Refusal.TOO_LARGE -> "$name is still over 3 MB after shrinking it to ${JPEG_STEPS.last().maxSide} px"
        Refusal.OVER_MESSAGE_BUDGET -> "$name did not fit: the images in one message can total at most 3 MB"
        Refusal.GIF_TOO_LARGE -> "$name is a GIF over 3 MB; GIFs are sent unchanged to keep their animation"
        Refusal.UNSUPPORTED_TYPE -> "$name must be PNG, JPEG, WebP, or GIF"
        Refusal.UNREADABLE -> "$name could not be read"
    }

    /** What an EXIF orientation tag asks for, applied before the EXIF is dropped. */
    data class Orientation(val rotateDegrees: Int, val mirror: Boolean) {
        /** 90 and 270 swap width and height. */
        val swapsSides: Boolean get() = rotateDegrees % 180 != 0
    }

    /** EXIF `Orientation` values 1-8; anything else is upright. */
    fun orientation(exif: Int): Orientation = when (exif) {
        2 -> Orientation(0, true)
        3 -> Orientation(180, false)
        4 -> Orientation(180, true)
        5 -> Orientation(90, true)
        6 -> Orientation(90, false)
        7 -> Orientation(270, true)
        8 -> Orientation(270, false)
        else -> Orientation(0, false)
    }
}
