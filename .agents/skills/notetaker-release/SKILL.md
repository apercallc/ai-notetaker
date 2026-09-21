---
name: notetaker-release
description: Coordinate an AI Notetaker helper and extension release, including matching versions, guardrails review, cross-platform build evidence, packaging, and a single release tag.
---

# Release AI Notetaker

Keep helper and extension versions aligned because they share the Native
Messaging contract. Run the guardrails review, build/test the helper and
extension, package the extension, and report Linux/macOS/Windows artifacts
separately. Signing, notarization, updater keys, live provider calls, and
real Chrome pairing are external proof; never imply they happened from a
local build. Use one project release tag, not per-package tags.
