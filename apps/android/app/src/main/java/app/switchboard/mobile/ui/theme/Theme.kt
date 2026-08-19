package app.switchboard.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val SwitchboardColors = darkColorScheme(
    primary = Accent,
    onPrimary = OnAccent,
    primaryContainer = SurfaceRaised,
    onPrimaryContainer = TextPrimary,
    secondary = TextPrimary,
    onSecondary = Background,
    secondaryContainer = SurfaceSoft,
    onSecondaryContainer = TextPrimary,
    background = Background,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceRaised,
    onSurfaceVariant = TextDim,
    outline = Outline,
    outlineVariant = Outline,
    error = Red,
    onError = Background,
    errorContainer = SurfaceRaised,
    onErrorContainer = Red,
)

@Composable
fun SwitchboardTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = SwitchboardColors,
        typography = SwitchboardTypography,
        shapes = SwitchboardShapes,
        content = content,
    )
}
