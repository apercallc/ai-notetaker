# Launch checklist: Chrome Web Store and Google OAuth

Two tasks remain, and both need you (they need your accounts and, for the
store, a card). Everything else is automated. Start both on the same day:
each has a review that takes days, and they do not depend on each other.

| Task | Your time | Then you wait | Guide |
| --- | --- | --- | --- |
| Chrome Web Store listing | about 1 hour | a few days for review | [chrome-web-store.md](chrome-web-store.md) |
| Google OAuth and verification | about 45 minutes | a few business days | [google-oauth.md](google-oauth.md) |

## Order of operations

1. **Chrome Web Store, steps 1 to 4 first.** Create the draft, copy the store's
   public key, run `node scripts/rotate-extension-id.mjs "<key>"`, merge, and let
   the release publish. This makes the extension ID match what the helper
   expects. It is the only step that can quietly break things if skipped.
2. **Google Cloud and Search Console** in parallel (DNS record, project,
   consent screen, client).
3. Finish the store listing from the ready-made copy, submit, and submit the
   Google verification with the demo video.
4. When both are live: set `CHROME_WEB_STORE_URL` on Railway, and the site shows
   **Add to Chrome**.

## Materials

Ready to use under [`assets/`](assets/):

- `chrome-web-store/icon-128.png`
- `chrome-web-store/screenshot-1.png` to `screenshot-5.png` (1280x800, real
  screens from the current extension build)
- `chrome-web-store/promo-small-440x280.png`, `promo-marquee-1400x560.png`
- `google/logo-120.png`

Copy, permission justifications, data-usage answers, reviewer notes, scope
justifications and the demo-video script are in the two guides.

## Already done for you

- Privacy notice and terms are live at https://ai-notetaker.apercallc.com/privacy
  and `/terms`, including the Google "Limited Use" statement.
- The Google integration asks for the narrowest scopes (one sensitive scope),
  and the redirect URI and encryption key are set.
- `scripts/rotate-extension-id.mjs` (tested) handles the extension-ID change.
- The release workflow uploads to the store automatically once you add the
  credentials in step 10 of the store guide.
