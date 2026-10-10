# Native Google Account Screen Design

## Goal

Add a reusable native Compose Google Account surface matching the React Native
account behavior without wiring it into navigation or runtime composition. The
screen must support signed-out, signed-in, and blocked account presentation;
credential import; a callback-only QR affordance; and confirmed sign-out with
stable progress and error presentation.

## Scope

The slice adds files under `ui/google` and pure JVM tests. It reuses the existing
`GoogleAccountPresentation`, `GoogleCredentialImportResult`, and
`GoogleSignOutResult` contracts. It does not change `NativeAndroidRuntime`,
`SwitchboardApplication`, `MainActivity`, `SwitchboardNavigation`, or any
navigation/runtime wiring.

## State and data flow

`GoogleAccountUiReducer` owns only safe UI state: the public account
presentation, details disclosure, confirmation visibility, active operation,
public error, and an operation generation. Credential contents never enter the
reducer state or an effect/result model.

The Compose host keeps pasted credential text in non-saveable in-memory state.
It passes the text directly to the import callback, clears it on a successful
import, and never logs or renders it outside the masked input. Process
recreation therefore drops the draft instead of serializing a live credential.

Import and sign-out starts allocate a generation. Completion events are applied
only when both the operation and generation match, so a stale completion cannot
replace newer account or error state. Only one operation can be active.

## Presentation

The screen preserves the RN hierarchy and copy: title and short rationale,
collapsible details, signed-in account card, signed-out connection instructions,
scan-first callback affordance, paste/import field, and keychain warning.

A signed-in account shows its email when available and a generic connected label
otherwise. A blocked account shows only fixed nonsecret copy and retains the
import controls as a recovery path. It never accepts or displays the underlying
blocked storage reason.

Sign out opens a confirmation dialog. Confirming shows progress in a reserved
action region. Import progress and all public errors use reserved regions so
content does not jump as operations change.

## Accessibility

The root is a traversal group whose composition order is the spoken order.
Headings, disclosure state, account state, field label, button action/state, and
errors have explicit semantics. Errors use a polite live region. Material
controls provide immediate press indication and all actions have a minimum 48dp
target.

## Error policy

Reducer error copy is fixed by result category. Verification codes, storage
details, credential fragments, and exception messages are not rendered. A
remote revoke failure still presents sign-out success when local removal
succeeded, matching the coordinator contract.

## Testing

Pure JVM tests cover signed-out/signed-in/blocked presentation, disclosure,
import and sign-out transitions, confirmation, stale completion fencing,
fixed nonsecret errors, and accessibility labels/states. Verification also runs
production Kotlin compilation and AndroidTest compilation.

Camera launch, TalkBack spoken order, Switch Access, keyboard behavior, physical
touch feedback, large-font layout, and end-to-end credential import/sign-out
remain physical-device integration checks because this isolated slice has no
camera or runtime wiring.
