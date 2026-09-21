# AI Notetaker

An open-source, self-hosted alternative to Krisp-style AI meeting
notetakers — no required subscription, works with any meeting app (Zoom,
Google Meet, Microsoft Teams, Slack Huddles), and you bring your own AI API
key.

## Why

Commercial meeting notetakers charge a recurring subscription for
transcription and summarization that, at real-world usage, costs cents per
meeting in underlying API fees. This project pays that cost directly instead
— you plug in your own API key(s), pay the provider at cost, and own all of
your data.

## How it works

1. A small desktop helper app creates a virtual microphone/speaker, the same
   trick tools like Krisp use — you select it as your mic + speaker in your
   meeting app's settings, and it transparently passes audio through while
   capturing a copy.
2. A Chrome extension is your control surface: guided audio preflight, start/
   stop recording, a live transcript, meeting modes/custom vocabulary, and a
   cross-meeting action-item inbox.
3. Recordings are transcribed and summarized using your own API key(s) —
   no account, no backend billing, no subscription.
4. Optionally, deploy your own history web app (one click on Railway) if you
   want persistent, cross-device access to past meetings. It's entirely
   optional — the extension works standalone with local storage. The webapp
   adds an authenticated action-item inbox and due-date tracking.

## Status

Core capture, Native Messaging, CI, Tauri tray/packaging, and Linux/Windows
installer registration are implemented; native signing, the macOS post-copy
registration step, and live OS/audio validation remain. See
[`docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md`](docs/superpowers/specs/2026-09-21-notetaker-architecture-design.md)
for the current design and remaining roadmap.

## Repo structure

```
ai-notetaker/
├── extension/     # Chrome extension (Manifest V3)
├── helper/        # Tauri/Rust desktop capture helper, per-OS audio modules
├── webapp/        # Optional Next.js + Postgres history app, Railway template
├── docs/          # Setup guides, architecture specs
└── LICENSE         # MIT
```

## Supported platforms (planned)

- **Desktop capture**: macOS, Windows, Linux (Linux as a fast-follow)
- **Meeting apps**: anything that lets you choose a system mic/speaker —
  Zoom, Google Meet, Microsoft Teams, Slack Huddles, and more
- **Mobile**: not in scope yet — see the architecture doc for why cellular
  call recording isn't feasible on iOS/Android, and what is

## AI providers (bring your own key)

| Tier | Transcription | Summarization | Cost / 45-min meeting |
|---|---|---|---|
| Default | Deepgram | Claude Haiku | ~$0.21 |
| Budget | Groq (Whisper) | Gemini Flash / DeepSeek | ~$0.03 |

You can use any provider you have a key for — these are the recommended
defaults for quality-per-dollar.

## License

MIT — see [`LICENSE`](LICENSE).

## Contributing

This project is fully open source. Contributions welcome once the initial
implementation plan lands — see the architecture doc linked above for the
current design and roadmap.
