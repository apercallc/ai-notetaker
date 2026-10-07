# Data handling

The Tauri desktop app is the primary product. In local use, it stores recordings
and notes on this device and sends audio or transcript text only to the selected
AI provider. Optional web-app sync sends finished note text to one authenticated
workspace; it does not send raw audio or provider keys. Existing extension data
and the managed hosted-AI service remain supported during migration. Managed
mode sends authenticated recording chunks to private temporary staging; the
hosted library keeps meeting text, not the recording.

## Where data lives

| Data | Location | Leaves the device when |
| --- | --- | --- |
| Provider API keys | Desktop app: operating-system credential store; legacy extension: `chrome.storage.local`; managed mode: server-side provider secrets | Local BYOK sends keys only to the selected provider. Optional web-app sync never receives them. Managed mode never sends server secrets to a client |
| Google Drive credentials | Legacy extension storage or encrypted web-app credential storage, depending on which Google export flow is used | Used only for the user's Google export. The desktop-first local BYOK path does not require Google sign-in |
| Native Messaging pairing token | Legacy extension `chrome.storage.local` and the helper's private data directory | Never leaves the device; used only by the legacy extension/helper connection |
| Raw mic/speaker PCM | Desktop app: private app-data directory; legacy Meet: extension IndexedDB; legacy desktop calls: helper app-data directory | Local BYOK sends audio to the selected provider after saving it locally. Managed mode uploads authenticated chunks to private staging, then sends them to the configured transcription provider (Groq by default). Staging is deleted on success or expires within 24 hours; provider processing and retention follow that provider's terms/settings |
| Transcript and summary | Desktop app local store; legacy extension/helper storage; optionally the user's webapp/Postgres, managed workspace, or Google Drive Doc | Optional desktop sync sends finished note text only. Other notes leave the device only through the selected provider, managed workspace, or Google Drive export |
| Imported audio/video files | Browser upload to private processing staging, then a decoded 16 kHz mono copy on the processing server's temporary disk | Managed mode only. The staged original is deleted when notes are saved or after 24 hours; the decoded scratch copy is deleted when the job ends. Audio is sent to the configured transcription provider like a live recording. Only text notes are kept |
| Retry queues | Desktop app local store; legacy extension IndexedDB and helper app-data directory | Never sent; they reference local audio ranges or resumable upload state |
| Desktop UI control | Tauri IPC inside the desktop app; legacy extension control uses Native Messaging plus a local Unix socket/named pipe | Never sent to a project-operated server |
| Error reports | Managed webapp server and worker: Sentry, only when the operator sets `SENTRY_DSN`; legacy extension: bounded client-error records under its authenticated managed flow | Local desktop BYOK does not send error reports to the project |

For new recordings, the desktop app saves separate microphone and system-audio
channels locally before making a BYOK provider request. Legacy extension BYOK
requests originate from the extension after audio is saved in IndexedDB. In
managed mode, the hosted worker calls providers with server-side credentials;
the extension never receives those credentials. By default,
managed transcription sends the meeting's separate microphone and speaker
audio to Groq in short-lived WAV requests; summarization sends only the
resulting transcript text to OpenAI. Choosing Deepgram or Anthropic changes
the corresponding recipient. The project's temporary staging deletion policy
does not control provider-side processing or retention.

## Deletion

Delete a meeting from the desktop app's Notes view to remove its local files.
Legacy extension users can delete a meeting from the extension's detail view;
Meet audio is removed from IndexedDB and desktop-call audio is requested from
the helper. If the helper is offline, the extension-local deletion still
completes and the helper can be cleaned separately. For a complete local reset,
stop notes and quit AI Notetaker, then remove its private app-data directory as described in
[`helper-packaging.md`](helper-packaging.md). Deleting a meeting or the data
directory is permanent; export or copy data first when it must be retained.

Deleting a note or folder in the webapp library moves it to the Trash: it
disappears from lists, search, Ask your notes, action items and share links
immediately, stays restorable for 30 days, then is removed permanently (the
managed worker purges expired items).
"Delete forever" and "Empty trash" (owners only) remove items at once, and
workspace retention policies and account/workspace deletion remove trashed
notes too. The legacy `DELETE /api/meetings/:id` API and retention sweeps
delete permanently. Deleting a folder trashes every note inside it. Audit
events record who deleted or restored what (ids only, never note text).

Delete synced notes from the user's own webapp through its meeting detail
route or API. Managed users can delete hosted meetings and their text notes;
temporary audio is removed after successful processing and is not playable,
downloadable, or shareable from the hosted service. Share links (1 to 365 days, or no expiry)
can be revoked independently, and they stop working when the note is deleted. Removing the extension does not automatically
delete provider account data or a separately deployed webapp/managed workspace
database.

This is product documentation, not legal advice. Recording and provider data
retention obligations vary by jurisdiction and provider terms.
