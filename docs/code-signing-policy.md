# Code-signing policy

AI Notetaker ships native helper artifacts for Linux, macOS, and Windows.
Signing is part of the release boundary, not a substitute for local tests or
live OS verification.

## Release requirements

- macOS artifacts are Developer ID signed and notarized before publication.
- Windows MSI/EXE artifacts are Authenticode signed with a trusted timestamp.
- Linux packages publish a checksum and the release manifest records the
  artifact as checksummed; repository and package-manager channels must point
  to the exact versioned artifact.
- The Chrome extension keeps its committed manifest key unchanged and is
  published separately through the Chrome Web Store.
- A release is not marked signed merely because a local build succeeded. The
  release owner must verify the signature, checksum, and installer behavior on
  the target OS.

## SignPath Foundation

The project is applying for the free SignPath Foundation open-source program
(`https://signpath.org/apply`). Approval is an external prerequisite and may
take time. Once approved, the release workflow may submit eligible Windows
artifacts through the trusted GitHub Actions integration after the project,
policy, and required repository secrets are configured. Until then, no
SignPath-backed signing claim is made.

## Unsigned builds

Unsigned builds are maintainer/test artifacts only. Their installation steps
are documented in [`unsigned-install.md`](unsigned-install.md). They may not
be uploaded as the public release, used to enable
`RELEASE_SIGNING_CONFIRMED`, or described as protecting users from OS trust
warnings.

The Homebrew development Cask uses `no_quarantine` only because a locally
built unsigned `.app` cannot pass macOS quarantine assessment. It is not a
security feature and must not be used to hide a missing signature in a public
release; the published Cask must be regenerated from a signed release
manifest.

## Verification record

For each public release, retain the GitHub Actions run, release manifest,
SHA-256 manifest, signing-service request/result, and manual OS-install
results. Report local build/test evidence, signing evidence, and live-device
evidence as separate claims.
