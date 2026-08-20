# Native Home Recents Refresh

Home remains cache-first: persisted project/session snapshots render immediately for
every saved machine. For each currently ready machine, Home owns one refresh
coordinator keyed by connection ID and transport generation. The coordinator requests
only the project index, retains cached rows while the request is pending or fails, and
persists a successful response through the existing browse snapshot store.

Home collects the coordinator state directly, so a successful response updates Recents
while the screen remains mounted. Removing a machine, replacing its transport
generation, or leaving Home closes the old coordinator and fences late callbacks. No
failure writes an empty snapshot or replaces usable cached content.

Focused tests cover cache-first presentation, mounted-state replacement after success,
failure retention, the absence of an unnecessary workspace request, and disposal
fencing. The existing Browse screen continues to refresh projects and workspaces
together.
