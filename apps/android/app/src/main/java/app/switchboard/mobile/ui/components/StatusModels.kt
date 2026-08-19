package app.switchboard.mobile.ui.components

import androidx.compose.ui.graphics.Color
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.TextDim

enum class StatusTone(val indicatorColor: Color) {
    NEUTRAL(TextDim),
    INFO(Accent),
    SUCCESS(Green),
    WARNING(Amber),
    ERROR(Red),
}

enum class StatusIndicatorKind {
    NONE,
    INDETERMINATE,
    DETERMINATE,
}

sealed interface InlineStatusProgress {
    val indicatorKind: StatusIndicatorKind

    data object None : InlineStatusProgress {
        override val indicatorKind = StatusIndicatorKind.NONE
    }

    data object Indeterminate : InlineStatusProgress {
        override val indicatorKind = StatusIndicatorKind.INDETERMINATE
    }

    data class Determinate(val value: Float) : InlineStatusProgress {
        override val indicatorKind = StatusIndicatorKind.DETERMINATE
        val boundedValue: Float = value.coerceIn(0f, 1f)
    }
}
