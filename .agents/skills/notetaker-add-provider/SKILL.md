---
name: notetaker-add-provider
description: Add a BYOK transcription or summarization provider while preserving AI Notetaker interfaces, raw-audio resilience, key storage, honest streaming labels, tests, and cost documentation.
---

# Add an AI provider

First classify the provider as transcription or summarization. Implement the
existing helper trait, preserve raw-audio-before-network ordering and the
retry path, and test success/auth/rate-limit/unreachable responses with
mocked HTTP. Keep keys in `chrome.storage.local` and route settings-page
validation through the helper. Label batch providers honestly, add the
provider to the settings list and protocol, and document verified current
pricing rather than guessing.
