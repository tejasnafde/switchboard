package app.switchboard.mobile.ui.thread

import android.content.ClipData
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.switchboard.mobile.data.remote.HtmlLiveImages
import app.switchboard.mobile.domain.thread.HtmlLivePages
import app.switchboard.mobile.domain.thread.HtmlLivePhone
import app.switchboard.mobile.domain.thread.MessageSegment
import app.switchboard.mobile.platform.share.ShareImage
import app.switchboard.mobile.ui.theme.Background
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.TextPrimary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "HtmlLiveCard"

/** The open chat's live-page images; null outside a chat (no image is fetched). */
val LocalHtmlLive = staticCompositionLocalOf<HtmlLiveImages?> { null }

private sealed interface LiveImage {
    data object Loading : LiveImage
    data object Missing : LiveImage
    data class Shown(val still: StillImage) : LiveImage
}

/** A decoded still image and, when the stored image is a PNG, its bytes as stored. */
private class StillImage(val bitmap: ImageBitmap, val png: ByteArray?)

/** Decoded still images by key, so a row scrolled back into view does not decode again. */
private val bitmapCache = object : LinkedHashMap<String, StillImage>(8, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, StillImage>?) = size > 8
}

private fun decodeImage(dataUrl: String): StillImage? {
    val payload = HtmlLivePages.imageBase64(dataUrl) ?: return null
    return runCatching {
        val bytes = Base64.decode(payload, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let {
            StillImage(it.asImageBitmap(), bytes.takeIf(ShareImage::isPng))
        }
    }.onFailure { Log.w(TAG, "still image did not decode", it) }.getOrNull()
}

/**
 * A closed ```html-live page (an unclosed one renders as code). It shows the
 * still image the desktop stored, the source, and Open on desktop. With
 * Settings > Labs "Run live pages" on, a page the phone can run runs in
 * place of the image ([LivePage]).
 */
@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun HtmlLiveCard(segment: MessageSegment.HtmlLive) {
    val live = LocalHtmlLive.current
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val name = segment.title ?: "Live page"
    val key = remember(segment.source) { HtmlLivePages.imageKey(segment.source) }
    var image by remember(key) {
        mutableStateOf<LiveImage>(synchronized(bitmapCache) { bitmapCache[key] }?.let(LiveImage::Shown) ?: LiveImage.Loading)
    }
    var showSource by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf(false) }
    var fullScreen by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }
    val still = (image as? LiveImage.Shown)?.still
    val shown = still?.bitmap
    val runPages = LocalPhoneLiveRun.current
    val verdict = remember(segment.source, segment.closed) { HtmlLivePhone.verdict(segment.source, segment.closed) }

    LaunchedEffect(key, live) {
        if (image is LiveImage.Shown) return@LaunchedEffect
        val dataUrl = live?.load(key)?.image
        val decoded = dataUrl?.let { withContext(Dispatchers.Default) { decodeImage(it) } }
        if (decoded != null) synchronized(bitmapCache) { bitmapCache[key] = decoded }
        image = decoded?.let(LiveImage::Shown) ?: LiveImage.Missing
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SurfaceRaised)
            .combinedClickable(
                onClickLabel = if (shown != null) "View image" else null,
                onLongClickLabel = "Show actions",
                onClick = { if (shown != null) fullScreen = true },
                onLongClick = { sheet = true },
            )
            .semantics { contentDescription = "Live page: $name" },
    ) {
        Row(
            modifier = Modifier
                .padding(start = 10.dp)
                .heightIn(min = 40.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(name, color = TextDim, fontSize = 12.sp, modifier = Modifier.weight(1f))
            TextButton(onClick = { showSource = !showSource }) {
                Text("Source", color = TextDim, fontSize = 12.sp)
            }
        }
        if (showSource) {
            SourceText(segment.source)
        } else if (runPages && verdict is HtmlLivePhone.Verdict.Ok) {
            LivePage(
                key = key,
                source = segment.source,
                name = name,
                still = shown,
                placeholder = if (image == LiveImage.Loading) "Loading image..." else "No image yet.",
                onLongPress = { sheet = true },
                onZoomStill = { fullScreen = true },
            )
        } else {
            when (val state = image) {
                LiveImage.Loading -> Muted("Loading image...")
                LiveImage.Missing -> Muted("No image yet. Your Mac makes one the next time it is online.")
                is LiveImage.Shown -> FoldedImage(state.still.bitmap, name)
            }
            if (runPages && verdict is HtmlLivePhone.Verdict.DesktopOnly) Muted(HtmlLivePhone.DESKTOP_ONLY_NOTE)
        }
        result?.let { Muted(it) }
    }

    if (sheet) {
        ModalBottomSheet(onDismissRequest = { sheet = false }, containerColor = Surface) {
            Text(name, color = TextPrimary, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp))
            if (shown != null) {
                SheetAction("View image", "pinch to zoom") { sheet = false; fullScreen = true }
            }
            SheetAction("Show source", null) { sheet = false; showSource = true }
            SheetAction("Copy source", null) {
                sheet = false
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(name, segment.source))) }
            }
            if (still != null && !showSource) {
                SheetAction("Share image", "PNG, as captured") {
                    sheet = false
                    result = null
                    scope.launch {
                        result = ShareImage.share(context, name) {
                            still.png ?: ShareImage.encodePng(still.bitmap.asAndroidBitmap())
                        }
                    }
                }
            }
            if (live?.canOpenOnDesktop == true) {
                SheetAction("Open on desktop", "in the pane on your Mac") {
                    sheet = false
                    result = null
                    scope.launch {
                        result = live.openOnDesktop(segment.source, segment.title)
                    }
                }
            }
        }
    }

    if (fullScreen && shown != null) {
        ZoomableImage(shown, name) { fullScreen = false }
    }
}

@Composable
private fun Muted(text: String) {
    Text(text, color = TextDim, fontSize = 12.sp, modifier = Modifier.padding(10.dp))
}

@Composable
private fun SourceText(source: String) {
    Text(
        source,
        fontFamily = GeistMono,
        fontSize = 12.sp,
        color = TextPrimary,
        softWrap = false,
        modifier = Modifier
            .horizontalScroll(rememberScrollState())
            .padding(10.dp),
    )
}

/** Full card width, cut to the first [HtmlLivePages.MAX_HEIGHT] dp, as the desktop's folded frame. */
@Composable
private fun FoldedImage(bitmap: ImageBitmap, name: String) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val full = maxWidth * (bitmap.height.toFloat() / bitmap.width.coerceAtLeast(1))
        val max = HtmlLivePages.MAX_HEIGHT.dp
        Column {
            Image(
                bitmap = bitmap,
                contentDescription = "Still image of $name",
                contentScale = ContentScale.FillWidth,
                alignment = Alignment.TopCenter,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(min(full, max))
                    .clipToBounds(),
            )
            if (full > max) Muted("First ${HtmlLivePages.MAX_HEIGHT} px. Tap to view the whole image.")
        }
    }
}

@Composable
private fun SheetAction(label: String, hint: String?, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .padding(horizontal = 12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = TextPrimary)
            hint?.let { Text(it, color = TextDim, fontSize = 12.sp) }
        }
    }
}

@Composable
private fun ZoomableImage(bitmap: ImageBitmap, name: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        var offset by remember { mutableStateOf(Offset.Zero) }
        val zoom = rememberTransformableState { change, pan, _ ->
            scale = (scale * change).coerceIn(1f, 8f)
            offset = if (scale == 1f) Offset.Zero else offset + pan
        }
        Box(
            Modifier
                .fillMaxSize()
                .background(Background),
        ) {
            Image(
                bitmap = bitmap,
                contentDescription = "Whole still image of $name. Pinch to zoom.",
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .clipToBounds()
                    .transformable(zoom)
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
            )
            TextButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)) {
                Text("Close", color = TextPrimary)
            }
        }
    }
}
