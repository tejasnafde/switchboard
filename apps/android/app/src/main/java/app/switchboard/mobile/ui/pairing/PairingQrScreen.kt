package app.switchboard.mobile.ui.pairing

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.TextDim
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun PairingQrScreen(
    onBack: () -> Unit,
    onManual: () -> Unit,
    onSave: suspend (PairingSaveIntent) -> PairingSaveResult,
    onSaved: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    var permissionGranted by remember {
        mutableStateOf(context.hasCameraPermission())
    }
    var permissionRequested by rememberSaveable { mutableStateOf(false) }
    var scanState by remember { mutableStateOf<PairingQrState>(PairingQrState.Scanning()) }
    var cameraError by rememberSaveable { mutableStateOf<String?>(null) }
    var cameraRetry by rememberSaveable { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        permissionRequested = true
        permissionGranted = granted
    }

    LaunchedEffect(Unit) {
        if (!permissionGranted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    DisposableEffect(activity, context) {
        val lifecycle = (activity as? LifecycleOwner)?.lifecycle
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                permissionGranted = context.hasCameraPermission()
            }
        }
        lifecycle?.addObserver(observer)
        onDispose { lifecycle?.removeObserver(observer) }
    }

    fun submitPayload(rawPayload: String) {
        val next = PairingQrReducer.reduce(scanState, PairingQrEvent.Detected(rawPayload))
        if (next == scanState) return
        scanState = next
        val ready = next as? PairingQrState.ReadyToSave ?: return
        scope.launch {
            val result = try {
                onSave(PairingSaveIntent.Add(ready.submission))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                PairingSaveResult.Failure(
                    error.message?.takeIf(String::isNotBlank)
                        ?: "Could not save this machine",
                )
            }
            scanState = PairingQrReducer.reduce(
                scanState,
                PairingQrEvent.SaveCompleted(result),
            )
            if (scanState is PairingQrState.Saved) onSaved()
        }
    }

    Box(modifier = modifier.fillMaxSize().background(Surface)) {
        if (permissionGranted) {
            key(cameraRetry) {
                PairingCameraPreview(
                    enabled = !scanState.latched,
                    onDetected = ::submitPayload,
                    onCameraFailure = { message -> cameraError = message },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(246.dp)
                    .border(2.dp, Color.White.copy(alpha = 0.82f), RoundedCornerShape(24.dp)),
            )
            ScannerChrome(
                message = cameraError ?: (scanState as? PairingQrState.Scanning)?.message,
                saving = scanState is PairingQrState.ReadyToSave,
                onBack = onBack,
                onManual = onManual,
                onRetryCamera = cameraError?.let {
                    {
                        cameraError = null
                        cameraRetry += 1
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            CameraPermissionState(
                permanentlyDenied = permissionRequested && activity?.let {
                    !ActivityCompat.shouldShowRequestPermissionRationale(
                        it,
                        Manifest.permission.CAMERA,
                    )
                } == true,
                onRequest = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                onOpenSettings = { context.openApplicationSettings() },
                onManual = onManual,
                onBack = onBack,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
private fun ScannerChrome(
    message: String?,
    saving: Boolean,
    onBack: () -> Unit,
    onManual: () -> Unit,
    onRetryCamera: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(16.dp),
    ) {
        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("Back", color = Color.White)
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Bottom,
        ) {
            if (saving) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(bottom = 12.dp),
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = Color.White,
                        strokeWidth = 2.dp,
                    )
                    Text(
                        text = "Pairing securely…",
                        color = Color.White,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }
            Text(
                text = message
                    ?: "Point at the QR printed by Switchboard or shown in Desktop Settings → Mobile.",
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier
                    .background(Color.Black.copy(alpha = 0.64f), RoundedCornerShape(12.dp))
                    .padding(14.dp),
            )
            onRetryCamera?.let { retry ->
                Button(
                    onClick = retry,
                    modifier = Modifier.padding(top = 10.dp).heightIn(min = 48.dp),
                ) {
                    Text("Retry camera")
                }
            }
            OutlinedButton(
                onClick = onManual,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Type it instead", color = Color.White)
            }
        }
    }
}

@Composable
private fun CameraPermissionState(
    permanentlyDenied: Boolean,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit,
    onManual: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(20.dp),
    ) {
        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("Back")
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Camera access is needed", style = MaterialTheme.typography.titleLarge)
            Text(
                text = if (permanentlyDenied) {
                    "Allow camera access in Android settings to scan a pairing QR."
                } else {
                    "Switchboard only uses the camera while this scanner is open."
                },
                color = TextDim,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 10.dp, bottom = 20.dp),
            )
            Button(
                onClick = if (permanentlyDenied) onOpenSettings else onRequest,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Text(if (permanentlyDenied) "Open settings" else "Allow camera")
            }
            OutlinedButton(
                onClick = onManual,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Enter address manually")
            }
        }
    }
}

@OptIn(ExperimentalGetImage::class)
@Composable
private fun PairingCameraPreview(
    enabled: Boolean,
    onDetected: (String) -> Unit,
    onCameraFailure: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val lifecycleOwner = activity as? LifecycleOwner
    val previewView = remember(context) {
        PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    }
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    val analyzerExecutor = remember { Executors.newSingleThreadExecutor() }
    val analyzing = remember { AtomicBoolean(false) }

    AndroidView(factory = { previewView }, modifier = modifier)

    DisposableEffect(context, lifecycleOwner, previewView, enabled) {
        if (lifecycleOwner == null) {
            onCameraFailure("Camera lifecycle is unavailable")
            return@DisposableEffect onDispose { }
        }
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        var disposed = false
        val preview = Preview.Builder().build().also {
            it.surfaceProvider = previewView.surfaceProvider
        }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(analyzerExecutor) { imageProxy ->
            val mediaImage = imageProxy.image
            if (!enabled || mediaImage == null || !analyzing.compareAndSet(false, true)) {
                imageProxy.close()
                return@setAnalyzer
            }
            val input = InputImage.fromMediaImage(
                mediaImage,
                imageProxy.imageInfo.rotationDegrees,
            )
            scanner.process(input)
                .addOnSuccessListener(ContextCompat.getMainExecutor(context)) { barcodes ->
                    barcodes.firstNotNullOfOrNull { it.rawValue }?.let(onDetected)
                }
                .addOnFailureListener(ContextCompat.getMainExecutor(context)) { error ->
                    onCameraFailure(
                        error.message?.takeIf(String::isNotBlank)
                            ?: "Could not read the camera",
                    )
                }
                .addOnCompleteListener {
                    analyzing.set(false)
                    imageProxy.close()
                }
        }
        providerFuture.addListener(
            {
                if (disposed) return@addListener
                try {
                    provider = providerFuture.get().also { cameraProvider ->
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    }
                } catch (error: Throwable) {
                    onCameraFailure(
                        error.message?.takeIf(String::isNotBlank)
                            ?: "Could not start the camera",
                    )
                }
            },
            ContextCompat.getMainExecutor(context),
        )

        onDispose {
            disposed = true
            analysis.clearAnalyzer()
            provider?.unbind(preview, analysis)
        }
    }

    DisposableEffect(scanner, analyzerExecutor) {
        onDispose {
            scanner.close()
            analyzerExecutor.shutdown()
        }
    }
}

private fun Context.hasCameraPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private fun Context.openApplicationSettings() {
    startActivity(
        Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}
