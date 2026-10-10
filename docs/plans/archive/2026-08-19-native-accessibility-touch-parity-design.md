# Native Accessibility and Touch Parity

## Scope

Improve accessibility and touch behavior in `ConnectionsScreen`, `PairingScreen`, `BrowseScreen`, and `NewSessionScreen` without changing navigation, branding, hierarchy, or backend behavior. `ThreadScreen` and shared runtime/build configuration remain out of scope.

## Interaction behavior

Every interactive control retains its existing action and placement. Material buttons continue using their built-in indication. Custom machine, project, and conversation rows retain their immediate pressed background and also use the current Material indication. Provider choices use radio-button selection semantics while preserving their existing cards. All interactive controls have at least a 48dp touch target.

Long-press actions receive explicit accessibility labels. Machine, project, conversation, workspace, provider, profile, model, and runtime-mode controls expose deterministic identity and state descriptions. Disabled and selected states remain owned by Compose semantics rather than visual symbols alone.

## Reading and traversal

Each screen is one traversal group in existing composition order: top-bar navigation, content fields or rows, then primary and secondary actions. Section labels and page titles are headings where useful. Dynamic status and error messages use polite live-region semantics. Decorative chevrons, dots, and progress indicators do not create redundant focus stops.

## Stable layout

Progress indicators occupy fixed-size slots so adjacent labels do not shift. Pairing field support text, Pairing save errors, New Session launch errors, and per-conversation rename errors use one compact reserved line. No other blanket whitespace is introduced.

## Testing

Pure screen-local policies generate semantic descriptions and states and receive unit coverage. Existing presentation/reducer tests remain in scope. The project has no Compose UI-test dependency and build configuration is explicitly out of scope, so Android instrumentation tests will be compile-checked but not added or executed. TalkBack traversal, actual spoken copy, switch access, font scaling, and physical touch feel require real-device testing.
