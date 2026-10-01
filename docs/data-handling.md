# Data handling

AI Notetaker is local-first and supports both self-hosted BYOK operation and an
optional managed hosted-AI service. Local mode does not send meeting data to
the project. Managed mode sends encrypted, authenticated recording chunks to
private temporary staging for processing and billing. The hosted library keeps
meeting text, not the recording.

## Where data lives

| Data | Location | Leaves the device when |
| --- | --- | --- |
| Provider API keys | Chrome extension `chrome.storage.local` in local mode; server secrets in managed mode | Local mode sends keys only to the selected provider; managed mode never sends provider keys to the extension |
| Google Drive OAuth tokens | Chrome extension `chrome.storage.local` | Google receives them during OAuth/API calls; the project never sees them |
| Native Messaging pairing token | Chrome extension `chrome.storage.local` and the local helper's private data directory | Never leaves the device; it is used only across the local extension/helper channel |
| Raw mic/speaker PCM | Meet: extension IndexedDB; desktop calls: helper app-data directory under `ai-notetaker` | Local mode sends audio to the selected provider; managed mode uploads authenticated chunks to private processing staging, then sends them to the configured transcription provider (Groq by default). Our staging copy is deleted on success or expires within 24 hours; provider processing and retention follow that provider's account terms/settings |
| Transcript and summary | Helper/extension local storage, optionally the user's own webapp/Postgres, managed workspace, or Google Drive Doc | Notes leave the device only through the selected local provider, managed workspace, optional webapp sync, or Drive export |
| Imported audio/video files | Browser upload to private processing staging, then a decoded 16 kHz mono copy on the processing server's temporary disk | Managed mode only. The staged original is deleted when notes are saved or after 24 hours; the decoded scratch copy is deleted when the job ends. Audio is sent to the configured transcription provider like a live recording. Only text notes are kept |
| Retry queues | Meet: extension IndexedDB until processing succeeds; desktop calls: helper app-data directory | Never sent; they reference local audio ranges or resumable upload state |
| Helper status/control | Native Messaging plus a local Unix socket/named pipe | Never to a project-operated server |
| Error reports | Managed webapp server and worker: Sentry, only when the operator sets `SENTRY_DSN`; extension: a bounded error record (message, surface, optional stack/meeting id) posted to the hosted service's authenticated `/api/v1/client-errors` endpoint, only while signed in to Hosted AI | Local BYOK mode never sends error reports anywhere |

For Google Meet, local BYOK provider requests go directly from the extension
after the audio is in IndexedDB; desktop-call local BYOK requests go from the
helper. In managed mode, the hosted worker calls providers with server-side
credentials; the extension never receives those credentials. By default,
managed transcription sends the meeting's separate microphone and speaker
audio to Groq in short-lived WAV requests; summarization sends only the
resulting transcript text to OpenAI. Choosing Deepgram or Anthropic changes
the corresponding recipient. The project's temporary staging deletion policy
does not control provider-side processing or retention.

## Deletion

Delete a meeting from the extension's meeting detail view; Meet audio is
removed from extension IndexedDB and desktop audio is requested from the
helper. If the helper is offline, the extension-local deletion still
completes and the helper can be cleaned separately. For a complete local reset, stop and quit the helper,
then remove its
`ai-notetaker` app-data directory as described in
[`helper-packaging.md`](helper-packaging.md). Deleting a meeting or the data
directory is permanent; export or copy data first when it must be retained.

Deleting a note or folder in the webapp library moves it to the Trash: it
disappears from lists, search, Ask your notes, action items and share links
immediately, stays restorable for 30 days, then is removed permanently (the
managed worker, or page loads on a self-hosted instance, purge expired items).
"Delete forever" and "Empty trash" (owners only) remove items at once, and
workspace retention policies and account/workspace deletion remove trashed
notes too. The legacy `DELETE /api/meetings/:id` API and retention sweeps
delete permanently. Deleting a folder trashes every note inside it. Audit
events record who deleted or restored what (ids only, never note text).

Delete synced notes from the user's own webapp through its meeting detail
route or API. Managed users can delete hosted meetings and their text notes;
temporary audio is removed after successful processing and is not playable,
downloadable, or shareable from the hosted service. Expiring share links can
be revoked independently. Removing the extension does not automatically
delete provider account data or a separately deployed webapp/managed workspace
database.

This is product documentation, not legal advice. Recording and provider data
retention obligations vary by jurisdiction and provider terms.
