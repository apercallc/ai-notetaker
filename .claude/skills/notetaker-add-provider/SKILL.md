---
name: notetaker-add-provider
description: Scaffold a new BYOK (bring-your-own-key) transcription or summarization provider integration for AI Notetaker — e.g. adding support for a new speech-to-text or LLM API alongside the existing Deepgram/Groq/Claude/Gemini/DeepSeek options. Use this whenever the user says "add support for [provider]", "let users plug in [API]", or "add another transcription/LLM option", so every new provider follows the same interface, error-handling, and cost-documentation pattern instead of drifting into a one-off implementation.
---

# Notetaker: Add AI Provider

AI Notetaker's whole value proposition is BYOK: no subscription, users pay
providers directly (see the architecture spec,
`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`, §3.3).
A new provider integration is only safe to ship if it fits the same shape
as the existing ones — otherwise the pipeline's resilience guarantees (see
below) quietly stop applying to it.

## Before writing code

Ask (if not already answered): is this a **transcription** provider (audio
in, text out) or a **summarization/LLM** provider (text in, text out)? They
plug into different points in the pipeline.

## Steps

1. **Implement against the existing provider interface**, not a bespoke
   one-off client. The helper (Rust/Tauri) defines a shared trait/interface
   for each provider category — find it before writing new code, and match
   it. If no such interface exists yet because this is the first provider
   beyond the two defaults, that's a sign to extract one now rather than
   let a second implementation ossify a copy-pasted shape.
2. **Preserve the raw-audio-first resilience guarantee.** Per the
   architecture's non-negotiable constraints, raw audio is always saved to
   local disk before any provider call is attempted. A new provider must
   fail into the same retry-queue path as the existing ones — never a
   silent swallow of the audio if the API call errors.
3. **Handle streaming vs. batch honestly.** Deepgram's live-streaming
   endpoint is the default specifically because batch/chunked transcription
   has boundary artifacts (words split across chunk edges) and higher
   latency. If the new provider is batch-only (like Groq's Whisper), say so
   explicitly in its config/UI label — don't present it as equivalent to a
   true streaming provider.
4. **API keys stay in `chrome.storage.local`.** Never introduce a path
   where a new provider's key could end up in `chrome.storage.sync` or any
   server the project operates — that would violate the no-backend,
   no-data-liability design (§1, §5 of the spec).
5. **Document the real cost.** Look up current pricing and compute the
   same $/45-minute-meeting estimate used for the existing providers (see
   the cost table in `README.md` and the spec's §3.3). Add this provider to
   both tables. If you can't find reliable current pricing, say so rather
   than guessing — a wrong cost estimate undermines the "affordable and
   transparent" pitch more than an admitted gap does.
6. **Add it to the settings UI provider list**, including whether it's a
   "default", "budget", or neither (e.g. "experimental") tier, so users
   choosing between options see the same quality/cost framing used
   elsewhere in the product.

## Why this matters

Every provider is a promise to the user that switching to it won't degrade
the resilience or privacy guarantees the rest of the product relies on. The
fastest way to erode trust in an open-source, BYOK tool is a provider
integration that quietly behaves differently under failure than the ones
next to it in the settings menu.
