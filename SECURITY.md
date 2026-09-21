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

- The project does not operate a hosted backend, telemetry endpoint, or
  subscription service.
- Provider calls originate in the local helper and use keys held in the
  extension's `chrome.storage.local`; the optional webapp receives finished
  notes only when the user configures their own deployment.
- Native Messaging is allowlisted to the committed extension ID, and the
  helper adds a per-install pairing token. Do not replace this with a local
  TCP listener.
- Raw audio and local meeting data remain on the user's machine unless the
  user deliberately sends finished notes to their own webapp/provider.

See [`docs/data-handling.md`](docs/data-handling.md) for the storage and
deletion map.
