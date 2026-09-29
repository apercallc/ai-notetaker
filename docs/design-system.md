# AI Notetaker design system

The product name is **AI Notetaker** on every customer-facing surface. Keep
the same note-and-waveform mark, forest green, warm paper background, and
clear state labels across the Chrome extension, desktop helper, history app,
and marketing site.

## Brand assets

- Canonical mark: `branding/ai-notetaker-mark.svg`.
- Website and app use the SVG directly; extension and desktop PNG, ICO, and
  ICNS files are rendered from the same shape by
  `python3 scripts/generate-brand-icons.py` (requires Pillow).
- The system tray uses its platform-native idle, recording, and recovery
  status glyphs. A recording state must remain visibly red.
- Keep illustrations labeled as examples. Do not add fabricated customer
  quotes, endorsements, logos, or results.

## Interface rules

- Forest green is the primary action color (`#176c4b`); keep text and controls
  readable in both light and dark appearances.
- Primary actions are solid, secondary actions are quiet and outlined, and
  destructive actions keep a separate danger treatment.
- Use a 40 px minimum control height, visible keyboard focus, and OS reduced
  motion preference. Recording, warning, success, and error states also have
  a text label or icon so color is never the only cue.
- Give each screen one clear next action. Keep advanced configuration and
  optional integrations out of the way until users need them.
- Google Meet setup works without the desktop helper. Explain the helper only
  for desktop calls such as Zoom, Teams, and Slack. Preserve local-first audio
  storage, optional BYOK/Hosted modes, and user consent language.

## Open-source assets

Marketing illustrations use local, licensed Lucide SVG icons in
`site/icons/`. Serve assets from the repository; do not load an icon or font
CDN at runtime.
