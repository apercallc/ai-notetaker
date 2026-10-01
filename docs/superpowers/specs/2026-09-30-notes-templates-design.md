# Notes templates (2026-09-30)

Status: implemented for hosted processing, the extension picker and the helper.

## Behavior
- Templates are the existing meeting `mode`: General, Standup, Sales call, 1:1,
  Interview, Lecture (new). `custom` is accepted but behaves like General on
  hosted notes.
- A template adds named sections to the standard notes and a short guidance
  line (`webapp/src/lib/noteTemplates.ts`). The summarizer returns them in a
  new `sections` array (strict JSON schema for OpenAI, tool schema for
  Anthropic); General asks for an empty array. Interview guidance forbids
  hire/no-hire recommendations and inferring protected characteristics.
- Stored summaries are now markdown (`## Key points`, `## <section>`), so
  template sections render as headings. Older plain-text summaries still render.
- Where it is picked: the import form, the extension popup/widget/settings
  (the picker already existed; Lecture was added, and the helper accepts it),
  and the meeting page ("Notes template" + "Regenerate notes").
- Regenerate rewrites the summary from the stored transcript (no audio, no
  usage reservation). Limit 3 per meeting, claimed atomically; a failed attempt
  does not consume one. Existing action items are never deleted or reset; new
  ones are added only when their text is not already present. A user-chosen
  title is kept. Only hosted ("managed") meetings with a transcript and an
  active plan can be regenerated. Emits `meeting.regenerate_notes`.

## Not built
- Template sections for local BYOK summaries (they keep one-line mode hints).
- A cost ledger for regenerations (each is one summary call; see TODO.md).
- User-defined custom templates.
