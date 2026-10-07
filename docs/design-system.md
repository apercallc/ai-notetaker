# AI Notetaker design system

The product name is **AI Notetaker** on every customer-facing surface. Keep
the same note-and-waveform mark, forest green, warm paper background, and
clear state labels across the Chrome extension, desktop helper, history app,
and marketing site.

## Brand assets

- Canonical mark: `branding/ai-notetaker-mark.svg`.
- Website, app header, and browser-tab icon use the SVG directly; extension
  and desktop PNG, ICO, and ICNS files are rendered from the same shape by
  `python3 scripts/generate-brand-icons.py` (requires Pillow).
- The extension uses `AI Notetaker` as its display name and short name.
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

## Desktop and web stay one product

The desktop app (`helper/crates/app/ui`) and the web app share tokens, controls and
vocabulary so people never have to relearn the product:

- Tokens come from `webapp/src/app/globals.css`: paper `#f7f8f4`, surface, border
  `#dce4dc`, forest green `#176c4b`, danger `#c0392b`, and the dark-mode values. Controls
  are 40 px or taller, inputs 44 px, buttons and inputs use 10 px radius, cards 12–14 px.
- Navigation uses the web app's names, order and Lucide icons: **Library, Actions, Ask,
  Team, Plans & usage, Settings**. **Record** is the one desktop-only item. Ask, Team and
  Plans & usage appear once signed in to a hosted account, and Team only for owners.
- Page titles match the web: Library, Action items, Ask your notes, Team, Hosted AI
  (nav label "Plans & usage"), Settings. Each page has one short sentence-case line under
  the title; there are no all-caps eyebrows.
- Any new screen is added to both surfaces, or documented here as intentionally one-sided.

## Open-source assets

The public site (`webapp/src/marketing`) uses Lucide icons (ISC license)
through `lucide-react`, always via the `Icon` component: 1.75 stroke, decorative
by default, and never the only carrier of meaning, so every icon sits next to a
text label. Its typeface is Bricolage Grotesque (SIL OFL 1.1), self-hosted from
`webapp/src/marketing/fonts/`. Serve assets from the repository; do not load an
icon or font CDN at runtime.

Marketing-site rules: forest green and the paper background are shared with the
app; the one recording red is reserved for the recording dot; channel colors
(your microphone = forest, the meeting's audio = ochre) always come with a text
label. Avoid inline `style` attributes (use classes), shadows, and identical card
grids. Every claim on a marketing page must be true of the shipping product.
