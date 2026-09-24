# Cross-Browser Ports Design

Date: 2026-09-22
Status: Deferred historical design; the current release target is Chrome-first
Google Meet capture with the documented Chrome Native Messaging path.

## Problem

TODO.md sub-project 5 lists: "Cross-browser ports: Edge and Brave first
(near-zero-cost, same Manifest V3 base), Firefox as a real port (different
extension APIs)." Today the extension code (`chrome.*` APIs,
`manifest.json`) only targets Chrome, and — more specifically than the
extension code — the **helper's Native Messaging installer scripts only
register the host manifest in Chrome's own OS-specific locations**
(`~/Library/Application Support/Google/Chrome/...` on macOS,
`HKCU:\Software\Google\Chrome\NativeMessagingHosts` on Windows,
`/etc/opt/chrome/...` + `/etc/chromium/...` on Linux). Loading the same
built extension in Edge or Brave today would show "helper not found"
forever, because the helper never wrote a manifest into Edge's or Brave's
native-messaging directories — this was the actual gap, not the extension
code.

## Goals

- Edge and Brave: the *same* built extension works, once the helper
  registers its Native Messaging manifest in their directories too.
- Firefox: a real, separate manifest variant plus a Firefox-specific
  Native Messaging host manifest (different key name, different ID
  format, different OS paths), since Firefox's extension ID and
  Native-Messaging manifest shape are structurally different from
  Chrome's — not just a "same code, different store" port.
- Every install/uninstall script keeps the existing "never overwrite an
  unrelated manifest" safety check already in place for Chrome.

## Non-goals

- Actually publishing to the Chrome Web Store, Edge Add-ons store, or
  Mozilla AMO — external, release-owner work requiring accounts this
  environment doesn't have (same category as existing release-owner gates
  in TODO.md: signing certs, live device tests).
- A generic n-browser plugin system. Four browsers, hand-written per-OS
  paths — YAGNI beyond that until a fifth browser is a real ask.
- Safari. Not requested, and Safari App Extensions use a fundamentally
  different distribution model (bundled inside a signed macOS app via
  Xcode, not a WebExtension Native Messaging host) that would be its own
  sub-project.

## Phase A: Edge and Brave (Chromium family)

No extension code changes — Edge and Brave both implement the same
`chrome.*` extension APIs and Manifest V3 shape Chrome does. The gap is
entirely in the helper's installer scripts, which today hardcode Chrome's
paths only.

### Confirmed OS-specific Native Messaging locations

| Browser | macOS | Linux | Windows registry |
| --- | --- | --- | --- |
| Edge | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` | `~/.config/microsoft-edge/NativeMessagingHosts/` | `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\<name>` |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\<name>` |

Linux's `.deb` postinst already writes to `/etc/opt/chrome/native-messaging-hosts`
and `/etc/chromium/native-messaging-hosts` (system-wide) — add
`/etc/opt/microsoft/msedge/native-messaging-hosts` and a Brave system-wide
equivalent the same way, alongside the existing two `write_manifest` calls.

### Changes

- `helper/crates/app/scripts/macos/install-native-messaging.sh` /
  `uninstall-native-messaging.sh`: loop the existing single-manifest logic
  over an array of `(vendor label, manifest dir)` pairs instead of one
  hardcoded Chrome dir.
- `helper/crates/app/resources/windows/install-native-messaging.ps1` /
  `uninstall-native-messaging.ps1`: loop over an array of registry vendor
  paths instead of one hardcoded Chrome key.
- `helper/crates/app/scripts/debian/postinst` / `postrm`: add two more
  `write_manifest`/removal calls for Edge and Brave's Linux system dirs.
- Each browser gets its own manifest file/registry entry (not a single
  shared one) so an uninstall or a "leave unrelated manifest alone" check
  never has to reason about multiple browsers sharing one file.
- Docs (`docs/getting-started.md`, `docs/helper-packaging.md`): add
  "load unpacked in Edge/Brave" instructions alongside the existing Chrome
  Web Store step, since neither is published to a store here.

## Phase B: Firefox (real port)

Firefox is structurally different in two places this project actually
touches:

1. **Extension ID.** Chrome derives a stable ID from the committed
   `manifest.json` `key` field. Firefox has no equivalent — it needs an
   explicit, permanent `browser_specific_settings.gecko.id` (email-like
   string or GUID). Once chosen, this ID is exactly as permanent as the
   Chrome `key` field (`extension/CLAUDE.md`'s existing "never regenerate
   casually" rule applies equally here) — the Firefox Native Messaging
   host manifest is allowlisted to it. **Decision: `notetaker@apercallc.dev`**,
   matching the project's existing `apercallc` GitHub org/install-page
   domain (`https://apercallc.github.io/ai-notetaker/`) rather than
   inventing an unrelated identifier.
2. **Background script model.** Firefox does not implement
   `background.service_worker`; it uses a non-persistent event page via
   `background.scripts`. Per Mozilla's own migration guidance, a single
   manifest can declare both `service_worker` (Chrome/Edge/Brave) and
   `scripts` (Firefox uses this, ignoring `service_worker`) — Chrome
   silently ignores the unrecognized `scripts` key the same way Firefox
   ignores `service_worker`. **No separate bundle or build target
   needed** — `background.js` (the existing esbuild output) is loaded
   both ways since it's already a plain script with no
   service-worker-only API usage (checked: no `self.skipWaiting`,
   `clients.claim`, or other SW-only calls in `src/background.ts`).

### Native Messaging host manifest

Firefox's shape differs from Chrome's, not just its location:

```jsonc
{
  "name": "com.ainotetaker.helper",
  "description": "AI Notetaker desktop helper — bridges the Firefox extension to the local capture/pipeline process",
  "path": "__NM_HOST_BINARY_PATH__",
  "type": "stdio",
  "allowed_extensions": ["notetaker@apercallc.dev"]
}
```

(`allowed_extensions` with the gecko ID, not `allowed_origins` with a
`chrome-extension://` URL.)

### Confirmed Firefox-specific locations

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |
| Linux (system-wide, matches the existing `.deb`'s system-wide pattern) | `/usr/lib/mozilla/native-messaging-hosts/` |
| Windows registry | `HKCU:\Software\Mozilla\NativeMessagingHosts\<name>` |

### Changes

- `extension/manifest.json`: add `browser_specific_settings.gecko.id` and
  `background.scripts` (see above). No other manifest changes — permissions
  (`storage`, `nativeMessaging`, `alarms`) are all supported in Firefox.
- `helper/native-messaging-host-manifest/`: add
  `com.ainotetaker.helper.firefox.json.template` alongside the existing
  Chrome template.
- Same three installer script families as Phase A get a Firefox branch,
  using the Firefox template/shape instead of the Chrome one.
- `docs/getting-started.md`: Firefox install instructions note that a
  non-signed build only loads via `about:debugging` → "This Firefox" →
  "Load Temporary Add-on" (resets on browser restart) until the extension
  is actually signed by Mozilla (AMO) — release-owner work, same category
  as Chrome Web Store submission.

## Testing

- Extension: no new unit tests needed for Phase A (zero code change).
  Phase B: a manifest-shape test asserting `manifest.json` has both
  `gecko.id` and `background.scripts` set, so a future edit can't silently
  drop Firefox support.
- Helper: shell/PowerShell install scripts don't have a unit test harness
  today (verified by grepping `helper/crates/app/scripts` and
  `resources/windows` for any existing test runner — none exists; the
  existing scripts are validated by the "acceptance testing for native
  installers" TODO item, which is already flagged release-owner/manual).
  This plan follows the same existing pattern rather than inventing a new
  one: each new vendor branch is a small, reviewable diff mirroring the
  already-reviewed Chrome branch line-for-line, and the existing
  "refuse to overwrite an unrelated manifest" safety check is preserved
  per vendor.
- Manual verification (documented as release-owner/manual, matching the
  existing TODO.md gate for native installer acceptance): actually loading
  the built extension in real Edge, Brave, and Firefox installs and
  confirming the helper handshake completes.

## Rollout

No feature flag. Existing Chrome behavior is unchanged (its branch of
each script is untouched, only added to); Firefox users get a new,
separate manifest field that Chrome/Edge/Brave simply ignore.
