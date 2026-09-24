# Data handling

AI Notetaker is local-first and supports both self-hosted BYOK operation and an
optional managed hosted-AI service. Local mode does not send meeting data to
the project. Managed mode sends encrypted, authenticated recording chunks to
the user's selected hosted workspace for processing and billing.

## Where data lives

| Data | Location | Leaves the device when |
| --- | --- | --- |
| Provider API keys | Chrome extension `chrome.storage.local` in local mode; server secrets in managed mode | Local mode sends keys only to the selected provider; managed mode never sends provider keys to the extension |
| Google Drive OAuth tokens | Chrome extension `chrome.storage.local` | Google receives them during OAuth/API calls; the project never sees them |
| Native Messaging pairing token | Chrome extension `chrome.storage.local` and the local helper's private data directory | Never leaves the device; it is used only across the local extension/helper channel |
| Raw mic/speaker PCM | Meet: extension IndexedDB; desktop calls: helper app-data directory under `ai-notetaker` | Local mode sends audio to the selected provider; managed mode uploads authenticated chunks to the hosted workspace |
| Transcript and summary | Helper/extension local storage, optionally the user's own webapp/Postgres, managed workspace, or Google Drive Doc | Notes leave the device only through the selected local provider, managed workspace, optional webapp sync, or Drive export |
| Retry queues | Meet: extension IndexedDB until processing succeeds; desktop calls: helper app-data directory | Never sent; they reference local audio ranges or resumable upload state |
| Helper status/control | Native Messaging plus a local Unix socket/named pipe | Never to a project-operated server |

For Google Meet, local BYOK provider requests go directly from the extension
after the audio is in IndexedDB; desktop-call local BYOK requests go from the
helper. In managed mode, the hosted worker calls providers with server-side
credentials; the extension never receives those credentials.

## Deletion

Delete a meeting from the extension's meeting detail view; Meet audio is
removed from extension IndexedDB and desktop audio is requested from the
helper. If the helper is offline, the extension-local deletion still
completes and the helper can be cleaned separately. For a complete local reset, stop and quit the helper,
then remove its
`ai-notetaker` app-data directory as described in
[`helper-packaging.md`](helper-packaging.md). Deleting a meeting or the data
directory is permanent; export or copy data first when it must be retained.

Delete synced notes from the user's own webapp through its meeting detail
route or API. Managed users can delete hosted meetings, including uploaded
recording objects; expiring share links can be revoked independently. Removing
the extension does not automatically delete provider account data or a
separately deployed webapp/managed workspace database.

This is product documentation, not legal advice. Recording and provider data
retention obligations vary by jurisdiction and provider terms.
