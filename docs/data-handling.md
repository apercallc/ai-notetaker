# Data handling

AI Notetaker is local-first and self-hosted. The project does not receive
meeting data, operate a shared backend, or collect analytics.

## Where data lives

| Data | Location | Leaves the device when |
| --- | --- | --- |
| Provider API keys | Chrome extension `chrome.storage.local` | The selected provider receives its key with a direct provider request |
| Native Messaging pairing token | Chrome extension `chrome.storage.local` and the local helper's private data directory | Never leaves the device; it is used only across the local extension/helper channel |
| Raw mic/speaker PCM | Helper app-data directory under `ai-notetaker` | Audio chunks are sent to the selected transcription provider during recording |
| Transcript and summary | Helper/extension local storage, and optionally the user's own webapp/Postgres | The transcript is sent to the selected summarizer; finished notes leave the device only when optional webapp sync is enabled |
| Retry queues | Helper app-data directory under `ai-notetaker` | Never sent; they reference local audio ranges |
| Helper status/control | Native Messaging plus a local Unix socket/named pipe | Never to a project-operated server |

Provider requests go directly from the helper to the provider selected by the
user. The optional webapp never receives AI provider keys and never calls an
AI provider.

## Deletion

Delete a meeting from the extension's meeting detail view; the extension
requests deletion from the helper and removes its local copy. If the helper
is offline, the extension-local deletion still completes and the helper can
be cleaned separately. For a complete local reset, stop and quit the helper,
then remove its
`ai-notetaker` app-data directory as described in
[`helper-packaging.md`](helper-packaging.md). Deleting a meeting or the data
directory is permanent; export or copy data first when it must be retained.

Delete synced notes from the user's own webapp through its meeting detail
route or API. Removing the extension does not automatically delete a user's
provider account data or a separately deployed webapp database.

This is product documentation, not legal advice. Recording and provider data
retention obligations vary by jurisdiction and provider terms.
