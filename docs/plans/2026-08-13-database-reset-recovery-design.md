# Database reset recovery design

## Problem

Version 0.8.30 added a sidebar-role backfill whose JavaScript template literal
turned the intended SQLite `ESCAPE '\\'` clause into an empty escape string.
SQLite rejected the migration, and `getDb()` treated every non-native-load error
as database corruption. It therefore moved a healthy database aside and created
a fresh one.

## Design

Use SQLite `GLOB 'agent_*'` for the agent-thread prefix check. Unlike `LIKE`,
`GLOB` treats `_` literally and needs no escape clause.

Restrict automatic database replacement to errors whose SQLite code is
`SQLITE_CORRUPT` or `SQLITE_NOTADB`. Native binding failures and all other open,
I/O, configuration, and migration errors must leave the database files in place
and surface the failure. This makes a failed migration recoverable by shipping a
fixed build instead of turning it into apparent data loss.

## Testing

Add regression coverage that opens and migrates a populated pre-sidebar-role
database, verifies `agent_` IDs are classified as managed, and verifies similar
IDs are not. Add unit coverage for the reset classification so ordinary
`SQLITE_ERROR` migration failures cannot move the database aside.

## Recovery and release

Quit Switchboard, snapshot the fresh 0.8.30 database files, use SQLite's backup
API to consolidate the preserved healthy database and WAL into a clean restored
database, verify it with `quick_check` and row counts, then launch the fixed
build. Release the fix as 0.8.31 through the existing tag-triggered pipeline.
