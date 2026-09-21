---
name: notetaker-design-review
description: Apply Apple-caliber design rigor and polish to any UI, UX, or interaction work in AI Notetaker — the Chrome extension popup, the onboarding wizard, the desktop helper's native tray/menu UI, or the webapp dashboard. Use this whenever building, redesigning, or reviewing any screen, component, layout, color choice, icon, spacing, animation, or piece of copy in this project — even if the user doesn't say "design" explicitly, e.g. "build the settings page", "make the onboarding flow", "style the popup", "add a recording indicator", "write the empty-state text". "Great user experience" is one of this project's three founding pillars (alongside affordability and open source) — treat polish as a requirement, not a nice-to-have.
---

# Notetaker Design Review

This project's pitch is "simple, affordable, open source, and a *great*
experience" (see `docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`,
§1). The other two pillars have dedicated tooling (`notetaker-guardrails-reviewer`
for architecture, `notetaker-add-provider`/`notetaker-release` for
consistency). This skill is that same treatment for design quality.

## The standard: Apple's three principles, applied here

Apple's own framing of good design — **Clarity, Deference, Depth** — maps
directly onto this project's surfaces:

- **Clarity**: text is legible at every size, icons are precise and mean
  one thing, functionality is obvious. A user recording their first meeting
  should never wonder "did that button work?"
- **Deference**: the UI gets out of the way of the *content* — the
  transcript, the summary, the action items. Chrome, borders, and
  decoration should never compete with the meeting notes for attention.
- **Depth**: visual layers and motion communicate hierarchy and give
  feedback (a recording indicator that pulses, a saved-note toast) — used
  sparingly, never as decoration for its own sake.

## Per-surface guidance

This project spans surfaces that live in different places — treat each as
native to its own environment rather than forcing one visual language onto
all three:

- **Chrome extension (popup + onboarding wizard)**: a polished, modern web
  UI. Apple-level restraint and typographic care, but don't fake macOS
  window chrome or SF Symbols inside a browser popup — that reads as
  uncanny, not premium. Respect the extension's small popup real estate;
  progressive disclosure over cramming.
- **Desktop helper tray/menu (macOS/Windows/Linux)**: this is the one place
  literal platform HIG applies. On macOS, follow the actual macOS menu bar
  conventions and SF Symbols; on Windows, follow Windows 11 tray/Fluent
  conventions; on Linux, follow the desktop environment's native tray
  idioms. A tray app that looks foreign to its OS undermines the "simple,
  it just works" pillar immediately.
- **Webapp (optional history dashboard)**: a clean, modern SaaS-dashboard
  aesthetic — information density done well (search, meeting list, note
  detail), not a marketing site. This is where a user goes to *find* a past
  meeting, so scanability and search matter more than visual flourish.

## Practical checklist (applies everywhere)

- **Typography**: a clear type scale, generous line-height for transcript
  text specifically (it's long-form reading), no more than 2 font weights
  per surface.
- **Color & dark mode**: every surface must support light and dark mode —
  meeting tools get used at all hours. Use color semantically (recording =
  one consistent color across all three surfaces, not reinvented per
  screen).
- **Spacing**: consistent rhythm (an 8px-based grid is a safe default),
  never cramped, never so sparse it wastes the popup's limited space.
- **Iconography**: one consistent icon set per surface, precise at small
  sizes — a recording indicator or mic icon has to read correctly at 16px.
- **Motion**: purposeful only (state changes, feedback), respects
  "reduce motion" accessibility settings, never decorative for its own
  sake.
- **Accessibility is not optional**: sufficient contrast ratios, keyboard
  navigation through the popup and wizard, screen-reader labels on icon-only
  buttons, Dynamic-Type-equivalent scalable text. A meeting notetaker that
  excludes users with accessibility needs has failed its own "great
  experience" pillar.
- **Microcopy**: concise, human, and consistent with the "simple,
  straightforward" tone set in the onboarding wizard (spec §6) — no jargon,
  no filler, say what will happen before it happens ("This will use your
  Deepgram key to transcribe live" beats a bare "Enable").

## Process

1. Before shipping any new screen, component, or significant copy change,
   dispatch the `notetaker-design-reviewer` agent against the relevant
   files for a critique.
2. For net-new UI from scratch (not a review of existing code), also draw
   on the general-purpose `frontend-design` skill for implementation
   technique — this skill sets the *standard*, `frontend-design` helps
   *build* to it.
3. Treat the reviewer's feedback the way you'd treat the guardrails
   agent's: specific, actionable findings to fix, not a rubber stamp.
