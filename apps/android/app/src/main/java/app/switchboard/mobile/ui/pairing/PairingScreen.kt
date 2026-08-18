package app.switchboard.mobile.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.TextDim
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun PairingScreen(
    editConnectionId: String?,
    initialForm: PairingForm?,
    onBack: () -> Unit,
    onSave: suspend (PairingSaveIntent) -> PairingSaveResult,
    onSaved: () -> Unit,
    onQrUnavailable: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (editConnectionId != null && initialForm == null) {
        MissingEditState(onBack = onBack, modifier = modifier)
        return
    }

    var label by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.label.orEmpty()) }
    var address by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.address.orEmpty()) }
    var token by rememberSaveable(editConnectionId) { mutableStateOf(initialForm?.token.orEmpty()) }
    var addressError by rememberSaveable(editConnectionId) { mutableStateOf<String?>(null) }
    var qrUnavailable by rememberSaveable(editConnectionId) { mutableStateOf(false) }
    var saveState by remember(editConnectionId) { mutableStateOf<PairingSaveState>(PairingSaveState.Idle) }
    val scope = rememberCoroutineScope()

    fun clearAddressError() {
        addressError = null
    }

    Column(modifier = modifier.fillMaxSize()) {
        PairingTopBar(isEditing = editConnectionId != null, onBack = onBack)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .navigationBarsPadding()
                .padding(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 132.dp),
        ) {
            Text(
                text = if (editConnectionId == null) "MACHINE ADDRESS" else "EDIT MACHINE",
                color = TextDim,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(bottom = 16.dp),
            )
            PairingField(
                label = "Name",
                value = label,
                placeholder = "optional",
                onValueChange = { label = it },
            )
            PairingField(
                label = "Address",
                value = address,
                placeholder = "ws://192.168.1.8:8765",
                mono = true,
                error = addressError,
                onValueChange = {
                    address = it
                    clearAddressError()
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
            Button(
                onClick = {
                    if (saveState is PairingSaveState.Saving) return@Button
                    val form = PairingForm(label = label, address = address, token = token)
                    when (val validation = PairingFormPolicy.validate(form)) {
                        is PairingValidation.Invalid -> addressError = validation.message
                        is PairingValidation.Valid -> {
                            val intent = PairingFormPolicy.intent(form, editConnectionId)
                                ?: return@Button
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
                },
                enabled = saveState !is PairingSaveState.Saving,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
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
                    Text(if (editConnectionId == null) "Connect" else "Save")
                }
            }
            (saveState as? PairingSaveState.Failed)?.let { failure ->
                Text(
                    text = failure.message,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 10.dp),
                )
            }
            if (editConnectionId == null) {
                OutlinedButton(
                    onClick = {
                        qrUnavailable = true
                        onQrUnavailable()
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp)
                        .heightIn(min = 48.dp),
                ) {
                    Text("Scan a QR instead")
                }
                if (qrUnavailable) {
                    Text(
                        text = "QR scanning is not available in this native milestone. Enter the address manually.",
                        color = TextDim,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(top = 10.dp),
                    )
                }
            }
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
        TextButton(
            onClick = onBack,
            modifier = Modifier.heightIn(min = 48.dp),
        ) {
            Text("Back")
        }
        Text(
            text = if (isEditing) "Edit machine" else "Pair backend",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(start = 8.dp),
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
    error: String? = null,
) {
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
            isError = error != null,
            supportingText = error?.let { message -> ({ Text(message) }) },
            textStyle = if (mono) {
                MaterialTheme.typography.bodyMedium.copy(fontFamily = GeistMono)
            } else {
                MaterialTheme.typography.bodyMedium
            },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = if (mono) KeyboardType.Uri else KeyboardType.Text,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

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
