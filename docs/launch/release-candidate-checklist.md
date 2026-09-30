# Release-candidate checklist

Everything the code cannot do for itself. Code, local tests and builds are
done; each item below needs an account, a device, or a publish action. Tick
items here and mirror the result into `TODO.md` ("Live release gates").

**Paid Hosted is "released" after Gate A. Public release needs Gate B.**

## Gate A: Hosted mode (blockers 1 to 4)

### 1. Stripe (verified live 2026-09-30)
- [x] `STRIPE_SECRET_KEY`, webhook secret and price IDs set on Railway `web`;
      `/api/health` reports `managedReady: true`.
- [x] Checkout, webhook and portal cancel tested end to end with a 100%-off
      one-time promotion code (invoice $0.00, workspace `hosted_pro`/`active`,
      `cancel_at` set).
- [ ] Confirm the key is the restricted one (Checkout Sessions + portal write,
      Prices read); Railway redacts the value, so check in the Stripe dashboard.
- [x] Portal return URL and privacy/terms URLs set; billing page shows
      "ends on <date>" for a pending cancellation.

### 2. Managed upload end to end
- [ ] Upload one real recording; job completes; staged audio object is gone.
- [ ] Force an expiry (short TTL on a test upload); worker sweep deletes it.
- [ ] Add a bucket lifecycle rule as a backstop (sweep is the only expiry
      today).

### 3. Live acceptance (capture evidence: screenshot or log per line)
- [ ] Chrome + Google Meet with real participants: widget, mic/speaker
      channels, notes produced.
- [ ] Helper Native Messaging on a real device: handshake, start/stop.
- [ ] Provider calls: Groq and OpenAI with real keys.
- [ ] Signed-in managed flow: signup email, login, upload, notes.

### 4. Physical audio checks
- [x] Linux (2026-09-24)
- [ ] macOS
- [ ] Windows

## Gate B: Public release (items 5 to 9)

- [ ] Bump/confirm version; `git tag vX.Y.Z`; push tag.
- [ ] Helper CI matrix green on that exact tag (Linux, macOS, Windows).
- [ ] GitHub Release published with artifacts; `release/manifest.json`
      `status`, `artifacts`, `chromeWebStoreUrl` filled.
- [ ] Installers acceptance-tested per OS, including the macOS DMG manual
      post-copy step and Native Messaging manifest auto-registration.
- [ ] Daily update check sees the new release.
- [ ] Decide launch-at-login default: ______
- [ ] Chrome Web Store: follow `chrome-web-store.md` steps 1 to 4 first
      (`node scripts/rotate-extension-id.mjs "<key>"`), then replace the dev
      ID in `allowed_origins`; verify the manifest `key` derives the
      published ID.
- [ ] Real screenshots from macOS, Windows, Linux for store listing, install
      page, README.

## Ops gaps

- [ ] Sentry alert rules (uptime monitor exists).
- [ ] Resend: send real signup and password-reset mail to Gmail and Outlook;
      confirm inbox, not spam (check SPF/DKIM/DMARC alignment).
- [ ] Google Cloud project + client per `google-oauth.md`; live sign-in test.
      Only non-sensitive scopes, so no verification queue.

## Decisions (not blockers)

- [ ] Hosted as primary onboarding CTA: needs an affordable trial policy
      (design spec section 6).
- [ ] Hosted live transcription stays off until server-side metering and a
      Deepgram token flow exist.
- [ ] Six RustSec unmaintained warnings (upstream Tauri/GTK): accept, no
      vulnerabilities.
- [ ] Code signing: unsigned first release with `docs/unsigned-install.md`.
