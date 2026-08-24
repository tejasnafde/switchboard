package app.switchboard.mobile.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.domain.iap.IapDiscoveredTarget
import app.switchboard.mobile.domain.iap.IapTargetSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun PairingScreen(
    editConnectionId: String?,
    startManual: Boolean,
    initialForm: PairingForm?,
    onBack: () -> Unit,
    onSave: suspend (PairingSaveIntent) -> PairingSaveResult,
    onSaved: () -> Unit,
    modifier: Modifier = Modifier,
    googleAccountReady: Boolean = false,
    onGoogleAccountRequired: () -> Unit = {},
    discoverIapTargets: suspend () -> IapTargetSelection = {
        IapTargetSelection(emptyList(), 0, 0)
    },
) {
    if (editConnectionId != null && initialForm == null) {
        MissingEditState(onBack = onBack, modifier = modifier)
        return
    }

    var manual by rememberSaveable(editConnectionId) {
        mutableStateOf(startManual || editConnectionId != null)
    }
    var kind by rememberSaveable(editConnectionId) {
        mutableStateOf(initialForm?.kind ?: PairingConnectionKind.WEBSOCKET)
    }
    if (!manual) {
        PairingQrScreen(
            onBack = onBack,
            onManual = { manual = true },
            onSave = onSave,
            onSaved = onSaved,
            modifier = modifier,
        )
        return
    }

    var label by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.label.orEmpty()) }
    var address by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.address.orEmpty()) }
    var token by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.token.orEmpty()) }
    var project by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.project.orEmpty()) }
    var zone by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.zone.orEmpty()) }
    var instance by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.instance.orEmpty()) }
    var port by rememberSaveable(editConnectionId) {
        mutableStateOf(initialForm?.port?.ifBlank { DEFAULT_IAP_PORT.toString() } ?: DEFAULT_IAP_PORT.toString())
    }
    var validationError by remember(editConnectionId) { mutableStateOf<PairingValidation.Invalid?>(null) }
    var saveState by remember(editConnectionId) { mutableStateOf<PairingSaveState>(PairingSaveState.Idle) }
    var iapDiscovery by remember(editConnectionId) {
        mutableStateOf<IapTargetSelection?>(null)
    }
    val scope = rememberCoroutineScope()

    LaunchedEffect(kind, editConnectionId) {
        if (kind == PairingConnectionKind.IAP && editConnectionId == null) {
            iapDiscovery = null
            iapDiscovery = discoverIapTargets()
        }
    }

    fun clearValidationError(field: PairingField) {
        if (validationError?.field == field) validationError = null
    }

    fun submit(form: PairingForm) {
        if (saveState is PairingSaveState.Saving) return
        when (val validation = PairingFormPolicy.validate(form, editConnectionId)) {
            is PairingValidation.Invalid -> validationError = validation
            is PairingValidation.Valid -> {
                if (
                    form.kind == PairingConnectionKind.IAP &&
                    IapGooglePrerequisitePolicy.submitAction(
                        googleAccountReady = googleAccountReady,
                        editing = editConnectionId != null,
                    ) ==
                    IapPrerequisiteAction.REQUEST_GOOGLE_ACCOUNT
                ) {
                    saveState = PairingSaveState.Failed(
                        "Choose a Google account before adding this work VM",
                    )
                    onGoogleAccountRequired()
                    return
                }
                val intent = PairingFormPolicy.intent(form, editConnectionId) ?: return
                saveState = PairingSaveReducer.reduce(
                    saveState,
                    PairingSaveEvent.Submit(intent),
                )
                scope.launch {
                    val result = try {
                        onSave(intent)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Throwable) {
                        PairingSaveResult.Failure(
                            error.message?.takeIf(String::isNotBlank)
                                ?: "Could not save this machine",
                        )
                    }
                    saveState = PairingSaveReducer.reduce(
                        saveState,
                        PairingSaveEvent.Completed(result),
                    )
                    if (saveState is PairingSaveState.Saved) onSaved()
                }
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .semantics { isTraversalGroup = true },
    ) {
        PairingTopBar(isEditing = editConnectionId != null, onBack = onBack)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 132.dp),
        ) {
            Text(
                text = when {
                    kind == PairingConnectionKind.IAP -> "WORK VM OVER IAP"
                    editConnectionId == null -> "MACHINE ADDRESS"
                    else -> "EDIT MACHINE"
                },
                color = TextDim,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(bottom = 16.dp),
            )
            if (editConnectionId == null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 20.dp),
                ) {
                    FilterChip(
                        selected = kind == PairingConnectionKind.WEBSOCKET,
                        onClick = {
                            kind = PairingConnectionKind.WEBSOCKET
                            validationError = null
                            saveState = PairingSaveState.Idle
                        },
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp),
                        label = { Text("WebSocket") },
                    )
                    FilterChip(
                        selected = kind == PairingConnectionKind.IAP,
                        onClick = {
                            kind = PairingConnectionKind.IAP
                            validationError = null
                            saveState = PairingSaveState.Idle
                        },
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp),
                        label = { Text("Google IAP") },
                    )
                }
            }
            if (kind == PairingConnectionKind.IAP && editConnectionId == null) {
                IapDiscoverySection(
                    presentation = PairingIapDiscoveryPolicy.present(iapDiscovery),
                    onSelect = { target ->
                        if (label.isBlank()) label = target.alias
                        project = target.project
                        zone = target.zone
                        instance = target.instance
                        validationError = null
                        saveState = PairingSaveState.Idle
                    },
                )
            }
            PairingField(
                label = "Name",
                value = label,
                placeholder = "optional",
                onValueChange = { label = it },
            )
            if (kind == PairingConnectionKind.WEBSOCKET) {
                PairingField(
                    label = "Address",
                    value = address,
                    placeholder = "ws://192.168.1.8:8765",
                    mono = true,
                    error = validationError.forField(PairingField.ADDRESS),
                    onValueChange = {
                        address = it
                        clearValidationError(PairingField.ADDRESS)
                    },
                )
                PairingField(
                    label = "Token",
                    value = token,
                    placeholder = "from the server",
                    mono = true,
                    onValueChange = { token = it },
                )
                Text(
                    text = "You can paste the full ws:// or wss:// pairing address. A pairing code in the address is used before any token entered here.",
                    color = TextDim,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(bottom = 16.dp),
                )
            } else {
                PairingField(
                    label = "Project",
                    value = project,
                    placeholder = "prj-...",
                    mono = true,
                    error = validationError.forField(PairingField.PROJECT),
                    onValueChange = {
                        project = it
                        clearValidationError(PairingField.PROJECT)
                    },
                )
                PairingField(
                    label = "Zone",
                    value = zone,
                    placeholder = "asia-south1-b",
                    mono = true,
                    error = validationError.forField(PairingField.ZONE),
                    onValueChange = {
                        zone = it
                        clearValidationError(PairingField.ZONE)
                    },
                )
                PairingField(
                    label = "Instance",
                    value = instance,
                    placeholder = "vm-name",
                    mono = true,
                    error = validationError.forField(PairingField.INSTANCE),
                    onValueChange = {
                        instance = it
                        clearValidationError(PairingField.INSTANCE)
                    },
                )
                PairingField(
                    label = "Port",
                    value = port,
                    placeholder = DEFAULT_IAP_PORT.toString(),
                    mono = true,
                    numeric = true,
                    error = validationError.forField(PairingField.PORT),
                    onValueChange = {
                        port = it
                        clearValidationError(PairingField.PORT)
                    },
                )
                PairingField(
                    label = "Backend token",
                    value = token,
                    placeholder = if (editConnectionId == null) "SWITCHBOARD_TOKEN" else "unchanged",
                    mono = true,
                    error = validationError.forField(PairingField.TOKEN),
                    onValueChange = {
                        token = it
                        clearValidationError(PairingField.TOKEN)
                    },
                )
                if (!googleAccountReady) {
                    Text(
                        text = "A Google account with Cloud IAP access is required before this VM can connect.",
                        color = TextDim,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                    OutlinedButton(
                        onClick = onGoogleAccountRequired,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 16.dp)
                            .heightIn(min = 48.dp),
                    ) {
                        Text("Set up Google account")
                    }
                }
            }
            Button(
                onClick = {
                    submit(
                        PairingForm(
                            kind = kind,
                            label = label,
                            address = address,
                            token = token,
                            project = project,
                            zone = zone,
                            instance = instance,
                            port = port,
                        ),
                    )
                },
                enabled = saveState !is PairingSaveState.Saving,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .semantics {
                        val saving = saveState is PairingSaveState.Saving
                        contentDescription = PairingAccessibilityPolicy.saveState(
                            editing = editConnectionId != null,
                            saving = saving,
                        )
                        stateDescription = if (saving) "In progress" else "Ready"
                    },
            ) {
                if (saveState is PairingSaveState.Saving) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .padding(end = 10.dp)
                            .size(18.dp),
                        strokeWidth = 2.dp,
                    )
                    Text(if (editConnectionId == null) "Connecting…" else "Saving…")
                } else {
                    Text(PairingPresentationPolicy.primaryAction(editConnectionId != null, kind))
                }
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 30.dp),
            ) {
                (saveState as? PairingSaveState.Failed)?.let { failure ->
                    Text(
                        text = failure.message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .padding(top = 8.dp)
                            .semantics {
                                liveRegion = LiveRegionMode.Polite
                                error(failure.message)
                            },
                    )
                }
            }
            if (editConnectionId == null) {
                OutlinedButton(
                    onClick = { manual = false },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp)
                        .heightIn(min = 48.dp),
                ) {
                    Text("Scan a QR instead")
                }
            }
        }
    }
}

sealed interface IapDiscoveryPresentation {
    data object Loading : IapDiscoveryPresentation
    data class Available(val targets: List<IapDiscoveredTarget>) : IapDiscoveryPresentation
    data class AllAdded(val count: Int) : IapDiscoveryPresentation
    data object Empty : IapDiscoveryPresentation
}

object PairingIapDiscoveryPolicy {
    fun present(selection: IapTargetSelection?): IapDiscoveryPresentation = when {
        selection == null -> IapDiscoveryPresentation.Loading
        selection.available.isNotEmpty() -> IapDiscoveryPresentation.Available(selection.available)
        selection.discoveredCount > 0 -> IapDiscoveryPresentation.AllAdded(selection.alreadyAddedCount)
        else -> IapDiscoveryPresentation.Empty
    }
}

@Composable
private fun IapDiscoverySection(
    presentation: IapDiscoveryPresentation,
    onSelect: (IapDiscoveredTarget) -> Unit,
) {
    Column(modifier = Modifier.padding(bottom = 16.dp)) {
        Text(
            text = "FROM CONNECTED MACS",
            color = TextDim,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        when (presentation) {
            IapDiscoveryPresentation.Loading -> Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            ) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                Text(
                    text = "Reading SSH config…",
                    color = TextDim,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(start = 10.dp),
                )
            }

            is IapDiscoveryPresentation.Available -> presentation.targets.forEach { target ->
                OutlinedButton(
                    onClick = { onSelect(target) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp)
                        .heightIn(min = 48.dp),
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(target.alias, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "${target.project} · ${target.zone}",
                            color = TextDim,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Spacer(modifier = Modifier.size(8.dp))
                    Text("Use")
                }
            }

            is IapDiscoveryPresentation.AllAdded -> Text(
                text = "All ${presentation.count} discovered VMs are already added.",
                color = TextDim,
                style = MaterialTheme.typography.bodyMedium,
            )

            IapDiscoveryPresentation.Empty -> Text(
                text = "No SSH-config VMs found on a connected Mac. Enter one manually below.",
                color = TextDim,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun PairingTopBar(isEditing: Boolean, onBack: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .heightIn(min = 56.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(
            onClick = onBack,
            modifier = Modifier
                .size(48.dp)
                .semantics { contentDescription = "Back" },
        ) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
        }
        Text(
            text = PairingPresentationPolicy.title(isEditing),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier
                .padding(start = 8.dp)
                .semantics { heading() },
        )
    }
}

@Composable
private fun PairingField(
    label: String,
    value: String,
    placeholder: String,
    onValueChange: (String) -> Unit,
    mono: Boolean = false,
    numeric: Boolean = false,
    error: String? = null,
) {
    val errorMessage = error
    Column(modifier = Modifier.padding(bottom = 16.dp)) {
        Text(
            text = label.uppercase(),
            color = TextDim,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text(placeholder) },
            singleLine = true,
            isError = errorMessage != null,
            supportingText = {
                Text(
                    text = errorMessage.orEmpty(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics {
                        if (errorMessage != null) liveRegion = LiveRegionMode.Polite
                    },
                )
            },
            textStyle = if (mono) {
                MaterialTheme.typography.bodyMedium.copy(fontFamily = GeistMono)
            } else {
                MaterialTheme.typography.bodyMedium
            },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = when {
                    numeric -> KeyboardType.Number
                    mono -> KeyboardType.Uri
                    else -> KeyboardType.Text
                },
            ),
            modifier = Modifier
                .fillMaxWidth()
                .semantics {
                    contentDescription = PairingAccessibilityPolicy.fieldDescription(label)
                    if (errorMessage != null) error(errorMessage)
                },
        )
    }
}

object PairingAccessibilityPolicy {
    fun fieldDescription(label: String): String = when (label) {
        "Address" -> "Machine address"
        "Token" -> "Pairing token"
        "Backend token" -> "Backend token"
        else -> label
    }

    fun saveState(editing: Boolean, saving: Boolean): String = when {
        saving && editing -> "Saving machine"
        saving -> "Connecting machine"
        editing -> "Save machine"
        else -> "Connect machine"
    }
}

object PairingPresentationPolicy {
    fun title(editing: Boolean): String = if (editing) "Edit machine" else "Add machine"

    fun qrTitle(): String = "Scan connection code"

    fun primaryAction(editing: Boolean, kind: PairingConnectionKind): String = when {
        editing -> "Save changes"
        kind == PairingConnectionKind.IAP -> "Add work VM"
        else -> "Connect securely"
    }
}

private fun PairingValidation.Invalid?.forField(field: PairingField): String? =
    this?.message?.takeIf { this.field == field }

@Composable
private fun MissingEditState(onBack: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxSize()) {
        PairingTopBar(isEditing = true, onBack = onBack)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Machine unavailable", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "This machine disappeared while the edit form was opening. Return to the list and try again.",
                color = TextDim,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
            )
            OutlinedButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Back to machines")
            }
        }
    }
}
