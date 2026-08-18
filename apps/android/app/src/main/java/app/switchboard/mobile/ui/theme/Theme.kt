package app.switchboard.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val SwitchboardColors = darkColorScheme(
    primary = Accent,
    onPrimary = Background,
    background = Background,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceRaised,
    onSurfaceVariant = TextDim,
    error = Red,
)

@Composable
fun SwitchboardTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = SwitchboardColors,
        typography = SwitchboardTypography,
        content = content,
    )
}
