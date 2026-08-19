# Native Android UI mock direction

## Goal

Create a complete, reviewable mock set before changing the native Android app. The mocks use the official T3 Code mobile app as an information-hierarchy reference while retaining Switchboard's identity, backend concepts, voice input, image attachments, pairing, Google account flow, and APK self-update lifecycle.

## Direction

The visual direction is calm, native, and instrument-like: near-black layered surfaces, restrained electric-blue accent, low-contrast hairlines, strong sans-serif hierarchy, and small monospace metadata. The interface should feel focused rather than decorative.

The thread is the primary surface. Its composer is a compact pill at rest and expands only for focus, content, or attachments. It exposes attachment, voice, and send/stop actions directly, but moves provider, model, runtime, and reasoning complexity into a dedicated settings route. Runtime choices are never rendered as a permanently scrolling row.

## Behavioral constraints visible in the mocks

- Cached thread content remains visible during refresh; synchronization appears as a compact contextual status.
- The keyboard moves the composer as one unit and never creates blank space inside it.
- Voice instructions appear only while recording and do not resize the composer.
- Approvals and questions replace the composer slot temporarily instead of stacking over it.
- Update discovery is silent when current. Available, downloading, ready, and failure states use a compact reserved banner that never covers input controls.
- Phone-originated text and images appear optimistically on the phone and synchronously on the desktop.
- Internal prompt metadata such as plugin, environment, or agent-instruction bundles never appears in the transcript.
- Offline and reconnecting states preserve useful content and queued drafts.
- All primary touch controls meet the existing 48 dp Android target contract.

## Mock inventory

The review board covers connections, QR/manual pairing, projects, thread list, new session, thread idle/typing/running, approval, offline/syncing, model/runtime settings, image attachment and preview, voice recording, Google/account settings, self-update states, and empty/error/reconnection states.

## Reference boundaries

We adopt T3 Code's calm hierarchy, contextual status, compact composer, full-page Android pickers, and measured-space responsiveness. We do not copy its branding, content, or architecture. Switchboard keeps its canonical mark, blue accent, system compatibility contracts, and product-specific capabilities.

## Review gate

No production UI implementation begins until the rendered mock board is shown to and approved by the user. Behavioral fixes may be planned alongside the mocks, but implementation remains gated by that approval.

## Approved Material 3 refinement

The mock must represent real product screens, not a gallery of mutually exclusive states. Machine details shows only the current connection state. Reconnecting uses an indeterminate circular progress indicator; downloads use a determinate linear progress indicator; transient connection and update feedback uses the `Scaffold` snackbar host. Empty content belongs to the screen that owns the empty collection, and update management belongs under Settings and Version.

Standard Material 3 structure is the baseline: `Scaffold`, `TopAppBar`, `ListItem`, `HorizontalDivider`, `IconButton`, standard buttons, progress indicators, dialogs, and snackbars. Custom surfaces remain limited to domain-specific content such as the chat composer, approval cards, voice capture, and image attachments. Alternative states may appear outside phone artboards as implementation reference strips, never as a fake end-user screen.
