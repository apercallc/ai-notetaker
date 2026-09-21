---
name: notetaker-release
description: Coordinate a versioned release of AI Notetaker across the desktop helper (macOS/Windows/Linux) and the Chrome extension together, since they must stay in lockstep. Use this whenever the user says "cut a release", "ship a new version", "bump the version", or "build the helper for release" for this project — never bump the extension manifest version or tag a helper release in isolation, since a mismatched helper/extension pair breaks the Native Messaging handshake between them.
---

# Notetaker Release

The helper and extension talk to each other over Native Messaging with a
version-checked handshake (see the architecture spec at
`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`, §3.2).
Shipping one without the other — or shipping them at different versions —
breaks that handshake for anyone who updates one half and not the other.
This skill keeps them moving together.

## Steps

1. **Confirm the release scope.** Ask the user (if not already stated)
   whether this release touches the helper, the extension, or both. Most
   releases touch both, since most features span the Native Messaging
   boundary.
2. **Bump versions together.**
   - `extension/manifest.json` → `version`
   - `helper/Cargo.toml` → `package.version` (or `helper/tauri.conf.json`
     if Tauri's version lives there instead once the project is scaffolded)
   - Keep these two numbers equal. If they've drifted, that's a bug to fix
     as part of this release, not something to paper over.
3. **Run the guardrails check before building.** Invoke the
   `notetaker-guardrails-reviewer` agent against the diff since the last
   release tag, so a constraint violation (e.g. an Electron dependency
   sneaking into the helper, a `chrome.storage.sync` call for API keys)
   doesn't ship. Fix anything it flags before proceeding.
4. **Build the helper for all three platforms.** Once the helper has a
   build pipeline (Tauri's `tauri build`), produce macOS, Windows, and
   Linux artifacts in the same run so they're always released together,
   never one platform ahead of the others.
5. **Package the extension.** Zip `extension/` per Chrome Web Store
   packaging requirements.
6. **Update the changelog and cost table.** If this release changed
   default AI providers or their pricing, update the cost table in both
   `README.md` and the architecture spec — those numbers going stale is a
   quiet trust problem for an open-source, cost-transparency-focused
   project.
7. **Tag the release** as `vX.Y.Z` in git, covering both packages together
   — do not use per-package tags like `helper-vX.Y.Z`, since a user
   installing "the latest release" needs one unambiguous version that
   covers both halves.

## Why this matters

The whole pitch of this project is "simple and it just works" — a user
whose helper silently falls out of sync with their extension (or vice
versa) gets a confusing, hard-to-debug failure that looks like a bug in the
product rather than a version mismatch. Keeping releases atomic across both
packages is what prevents that support burden before it starts.
