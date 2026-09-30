# Security policy

AI Notetaker handles meeting audio, transcripts, summaries, and API tokens.
Please do not disclose a vulnerability in a public issue before users have had
time to update.

## Reporting

Use a GitHub private vulnerability report for this repository when available.
If private reporting is unavailable, open an issue titled **Private security
report requested** with no exploit details; a maintainer will provide a
private channel. Include the affected version/commit, operating system,
package (`helper`, `extension`, or `webapp`), impact, reproduction steps, and
any suggested mitigation. Never include real API keys, meeting audio, or
personal data in a report.

Reports are acknowledged within seven days when the repository is actively
maintained. The maintainer will triage severity, coordinate a fix and release,
and credit the reporter only with their permission.

## Scope and privacy guarantees

AI Notetaker has two modes, and the guarantees differ:

**Local (bring your own keys) mode**
- No account and no project-operated server. Provider calls originate in the
  local helper or the extension, using keys held in `chrome.storage.local`
  (never `chrome.storage.sync`). The optional webapp receives finished notes
  only when the user points the product at their own deployment.
- Raw audio and local meeting data stay on the user's machine unless the user
  deliberately sends finished notes to their own webapp or provider.

**Hosted AI mode (project-operated service)**
- The service is a multi-tenant web application. Audio is uploaded to private
  temporary staging, processed with server-side provider credentials that
  never reach the client, and deleted after successful processing (failed or
  abandoned uploads expire within 24 hours). Transcripts, summaries and action
  items are stored per workspace and isolated from other workspaces.
- Billing runs through Stripe; card data never touches the service. Optional
  Google sign-in requests only `openid email`; optional Calendar and Drive
  access is a separate opt-in with encrypted tokens.
- Error reporting to Sentry is enabled on the project-operated service only
  and excludes meeting content.
- Vulnerabilities in the hosted service (authentication, workspace isolation,
  billing, upload/object access) are in scope for reports.

**Both modes**
- Native Messaging is allowlisted to the committed extension ID, and the
  helper adds a per-install pairing token. Do not replace this with a local
  TCP listener.

See [`docs/data-handling.md`](docs/data-handling.md) for the storage and
deletion map.
