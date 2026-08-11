# Codex file-change rendering parity

## Problem

Codex app-server reports edits as `fileChange` items containing `changes: [{ path, kind, diff }]`. Switchboard labels the item as Edit but forwards the untouched `changes` array. The shared Edit renderer expects `file_path`, `old_string`, and `new_string`, so it falls back to a raw JSON code block.

## Design

Normalize each Codex file change at the adapter boundary. A multi-file item becomes one existing Edit tool event per changed file. The adapter converts the unified patch into old/new text by retaining context on both sides, removed lines on the old side, and added lines on the new side. This gives Codex the same file label and red/green Edit presentation as Claude without adding provider-specific renderer code.

Completed file-change events mark every derived Edit tool complete without using the structured change payload as output. Other Codex tool items and the turn-level aggregate diff remain unchanged.

## Testing

- Feed the adapter the current Codex 0.144.1 `fileChange` wire shape.
- Assert that it emits one Claude-compatible Edit event per file.
- Assert that removed, added, and shared context lines map to the correct old/new strings.
- Assert that the raw `changes` protocol payload is not emitted as tool output.
