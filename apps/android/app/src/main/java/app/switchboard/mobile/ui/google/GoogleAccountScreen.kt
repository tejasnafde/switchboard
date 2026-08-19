package app.switchboard.mobile.ui.google

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.password
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleCredentialImportResult
import app.switchboard.mobile.platform.google.GoogleSignOutResult
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.components.InlineStatus
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.components.StatusTone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun GoogleAccountScreen(
    accountPresentation: GoogleAccountPresentation,
    onBack: () -> Unit,
    onScanQr: () -> Unit,
    onImportCredentials: suspend (String) -> GoogleCredentialImportResult,
    onSignOut: suspend () -> GoogleSignOutResult,
    informationalNotice: String? = null,
    modifier: Modifier = Modifier,
) {
    var uiState by remember { mutableStateOf(GoogleAccountUiReducer.initial(accountPresentation)) }
    // A live credential is intentionally neither saveable nor part of reducer state.
    var credentialDraft by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    LaunchedEffect(accountPresentation) {
        uiState = GoogleAccountUiReducer.reduce(
            uiState,
            GoogleAccountUiEvent.AccountChanged(accountPresentation),
        )
    }

    fun dispatch(event: GoogleAccountUiEvent) {
        uiState = GoogleAccountUiReducer.reduce(uiState, event)
    }

    fun importCredential() {
        if (credentialDraft.isBlank()) return
        dispatch(GoogleAccountUiEvent.ImportStarted)
        val operation = uiState.operation as? GoogleAccountUiOperation.Importing ?: return
        val submittedCredential = credentialDraft
        scope.launch {
            val result = try {
                onImportCredentials(submittedCredential)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                dispatch(GoogleAccountUiEvent.ImportFailed(operation.generation))
                return@launch
            }
            val completionIsCurrent = uiState.operation == operation
            dispatch(GoogleAccountUiEvent.ImportCompleted(operation.generation, result))
            if (completionIsCurrent && result is GoogleCredentialImportResult.Success) {
                credentialDraft = ""
            }
        }
    }

    fun confirmSignOut() {
        dispatch(GoogleAccountUiEvent.SignOutConfirmed)
        val operation = uiState.operation as? GoogleAccountUiOperation.SigningOut ?: return
        scope.launch {
            val result = try {
                onSignOut()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                dispatch(GoogleAccountUiEvent.SignOutFailed(operation.generation))
                return@launch
            }
            dispatch(GoogleAccountUiEvent.SignOutCompleted(operation.generation, result))
        }
    }

    GoogleAccountContent(
        state = uiState,
        credentialDraft = credentialDraft,
        informationalNotice = informationalNotice,
        onCredentialDraftChange = { credentialDraft = it },
        onBack = onBack,
        onToggleDetails = { dispatch(GoogleAccountUiEvent.DetailsToggled) },
        onScanQr = onScanQr,
        onImport = ::importCredential,
        onRequestSignOut = { dispatch(GoogleAccountUiEvent.SignOutRequested) },
        modifier = modifier,
    )

    if (uiState.signOutConfirmationVisible) {
        AlertDialog(
            onDismissRequest = { dispatch(GoogleAccountUiEvent.SignOutDismissed) },
            title = { Text("Sign out of Google?") },
            text = {
                Text(
                    "This revokes the Google credential and removes it from this device. " +
                        "Work VM connections over IAP will stop until you reconnect.",
                )
            },
            dismissButton = {
                TextButton(
                    onClick = { dispatch(GoogleAccountUiEvent.SignOutDismissed) },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text("Cancel")
                }
            },
            confirmButton = {
                TextButton(
                    onClick = ::confirmSignOut,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text("Sign out")
                }
            },
        )
    }
}

@Composable
private fun GoogleAccountContent(
    state: GoogleAccountUiState,
    credentialDraft: String,
    informationalNotice: String?,
    onCredentialDraftChange: (String) -> Unit,
    onBack: () -> Unit,
    onToggleDetails: () -> Unit,
    onScanQr: () -> Unit,
    onImport: () -> Unit,
    onRequestSignOut: () -> Unit,
    modifier: Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .semantics { isTraversalGroup = true },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .heightIn(min = 56.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
            Text(
                text = "Google account",
                style = MaterialTheme.typography.headlineLarge,
                modifier = Modifier
                    .weight(1f)
                    .semantics { heading() },
            )
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.account is GoogleAccountPresentation.SignedIn) {
                AccountCard(state.account)
                AccountStatusCard(state.account)
                SectionLabel("Account actions", Modifier.padding(top = 12.dp))
                SignOutAction(
                    operation = state.operation,
                    onRequestSignOut = onRequestSignOut,
                )
            } else {
                Text(
                    text = "Connect Google only when you need to reach work VMs over IAP.",
                    color = TextDim,
                    style = MaterialTheme.typography.bodyMedium,
                )
                TextButton(
                    onClick = onToggleDetails,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .semantics {
                            contentDescription = "Why this is needed"
                            stateDescription = GoogleAccountAccessibilityPolicy.detailsState(
                                state.detailsExpanded,
                            )
                        },
                ) {
                    Text(if (state.detailsExpanded) "Hide details" else "Why this is needed")
                }
                if (state.detailsExpanded) {
                    Text(
                        text = "Google Cloud IAP provides the secure relay to a work VM. " +
                            "Credentials stay encrypted on this device and are used only while connecting.",
                        color = TextDim,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                InformationalNoticeSlot(informationalNotice)
                CredentialImportPanel(
                    credentialDraft = credentialDraft,
                    operation = state.operation,
                    onCredentialDraftChange = onCredentialDraftChange,
                    onScanQr = onScanQr,
                    onImport = onImport,
                )
            }

            ErrorSlot(
                GoogleAccountUiPresenter.visibleError(state.account, state.errorMessage),
            )

            OperationStatusSlot(state.operation)
        }
    }
}

@Composable
private fun InformationalNoticeSlot(message: String?) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = if (message == null) 0.dp else 64.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (message != null) {
            InlineStatus(
                message = "Account setup",
                detail = message,
                tone = StatusTone.INFO,
            )
        }
    }
}

@Composable
private fun OperationStatusSlot(operation: GoogleAccountUiOperation) {
    val message = when (operation) {
        is GoogleAccountUiOperation.Importing -> "Verifying credentials…"
        is GoogleAccountUiOperation.SigningOut -> "Signing out…"
        GoogleAccountUiOperation.Idle -> null
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(24.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (message != null) {
            Text(
                text = message,
                color = TextDim,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

@Composable
private fun AccountCard(account: GoogleAccountPresentation.SignedIn) {
    val value = GoogleAccountUiPresenter.accountValue(account)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = if (account.email.isNullOrBlank()) {
                    value
                } else {
                    "Signed in as $value"
                }
                stateDescription = GoogleAccountAccessibilityPolicy.accountState(account)
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(64.dp)
                .background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = GoogleAccountUiPresenter.monogram(account),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
        Column(modifier = Modifier.padding(start = 16.dp)) {
            Text("Google account", color = TextDim, style = MaterialTheme.typography.labelMedium)
            Text(
                text = value,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.titleLarge,
            )
        }
    }
}

@Composable
private fun AccountStatusCard(account: GoogleAccountPresentation) {
    InlineStatus(
        message = GoogleAccountUiPresenter.statusTitle(account),
        detail = GoogleAccountUiPresenter.statusSupportingText(account),
        tone = StatusTone.SUCCESS,
    )
}

@Composable
private fun ErrorSlot(message: String?) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (message != null) {
            Text(
                text = message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics {
                    liveRegion = LiveRegionMode.Polite
                    error(message)
                },
            )
        }
    }
}

@Composable
private fun CredentialImportPanel(
    credentialDraft: String,
    operation: GoogleAccountUiOperation,
    onCredentialDraftChange: (String) -> Unit,
    onScanQr: () -> Unit,
    onImport: () -> Unit,
) {
    val importing = operation is GoogleAccountUiOperation.Importing
    val enabled = operation == GoogleAccountUiOperation.Idle
    Text(
        text = "Connect your Google account",
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.semantics { heading() },
    )
    Text(
        text = "Needed only to reach work VMs over IAP.",
        color = TextDim,
        style = MaterialTheme.typography.bodySmall,
    )
    Text(
        text = "On the desktop app, open Settings, then Mobile, then select Connect Google " +
            "account. Sign in when the browser opens. Scan the QR it shows you.",
        color = TextDim,
        style = MaterialTheme.typography.bodySmall,
    )
    Button(
        onClick = onScanQr,
        enabled = enabled,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .semantics {
                contentDescription = "Scan QR from desktop"
                stateDescription = if (enabled) "Ready" else "Unavailable while busy"
            },
    ) {
        Text("Scan QR from desktop")
    }
    Text(
        text = "or paste it",
        color = TextDim,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedTextField(
        value = credentialDraft,
        onValueChange = onCredentialDraftChange,
        enabled = enabled,
        label = { Text("Credential code") },
        placeholder = { Text("Paste the code from the desktop app") },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Password,
        ),
        minLines = 3,
        maxLines = 5,
        modifier = Modifier
            .fillMaxWidth()
            .semantics {
                contentDescription = "Google credential code"
                password()
            },
    )
    Button(
        onClick = onImport,
        enabled = enabled && credentialDraft.isNotBlank(),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .semantics {
                contentDescription = "Import credentials"
                stateDescription = GoogleAccountAccessibilityPolicy.importState(
                    hasCredentialDraft = credentialDraft.isNotBlank(),
                    operation = operation,
                )
            },
    ) {
        Box(
            modifier = Modifier.height(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (importing) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .size(18.dp)
                        .clearAndSetSemantics { },
                    strokeWidth = 2.dp,
                )
            } else {
                Text("Import credentials")
            }
        }
    }
    Text(
        text = "Stored in the device keychain. Treat it like a password.",
        color = TextDim,
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun SignOutAction(
    operation: GoogleAccountUiOperation,
    onRequestSignOut: () -> Unit,
) {
    val signingOut = operation is GoogleAccountUiOperation.SigningOut
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        TextButton(
            onClick = onRequestSignOut,
            enabled = operation == GoogleAccountUiOperation.Idle,
            modifier = Modifier.heightIn(min = 48.dp)
                .semantics {
                    contentDescription = "Sign out of Google"
                    stateDescription = GoogleAccountAccessibilityPolicy.signOutState(operation)
                },
        ) {
            if (signingOut) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .size(18.dp)
                        .clearAndSetSemantics { },
                    strokeWidth = 2.dp,
                )
            } else {
                Text("Sign out")
            }
        }
    }
}
