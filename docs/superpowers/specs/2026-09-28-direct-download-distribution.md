# Direct-download distribution and marketing site

Date: 2026-09-28  
Status: Current product direction

## Product decision

The public site is both the product landing page and the download guide. It
explains what the product does, presents real product value without invented
testimonials, and links each visitor to the platform artifact published in the
latest GitHub Release.

The Chrome extension is the short path for Google Meet. Desktop-call capture
uses the native Tauri helper for Zoom, Teams, Slack, and other desktop apps.
The optional webapp stores history; it is not part of desktop capture.

## Primary download targets

| Visitor device | Artifact | First release guidance |
| --- | --- | --- |
| Mac with Apple silicon (M1 or later) | Apple-silicon DMG | Drag to Applications, then Control-click → Open on first launch. |
| Windows 64-bit | x86_64 NSIS installer | If SmartScreen appears, check the official release and SHA-256, then More info → Run anyway for that installer. |
| Debian/Ubuntu Linux 64-bit | x86_64 `.deb` | Open in Software Install or install the downloaded file with `sudo apt install ./<file>.deb`. |

These targets are the supported first-release downloads, not a claim that
every operating system or Linux distribution has been tested.

## Budget and trust decision

Publish unsigned installers directly as versioned GitHub Release assets. Do
not block artifact publication on a paid Apple Developer Program membership,
Windows Authenticode certificate, external package registry, or Chrome Web
Store listing. Keep per-platform trust warnings visible. Never advise users to
disable Gatekeeper or SmartScreen globally.

Release SHA-256 values let a user detect a changed or damaged download when
they compare against the release's `SHA256SUMS`. They do not prove publisher
identity, source integrity, or safety. The release manifest must label the
artifacts `unsigned` and the site must not call them signed, verified, or
trusted based only on a checksum.

The Chrome extension link points to the Chrome Web Store when the listing URL
is configured. Before then, the tagged release's extension ZIP is a manual
fallback, and the UI must make that distinction clear. Native installer
publication must not depend on extension-store publication.

## Release contract

- Build an Apple-silicon Tauri DMG with target `aarch64-apple-darwin`.
- Build the Windows 64-bit NSIS installer for the primary download.
- Build and promote the Linux 64-bit `.deb` because it registers a stable
  Native Messaging relay. Do not publish AppImage until a stable
  install/registration path is implemented.
- Derive platform links, versions, architecture, and SHA-256 from the release
  manifest. Never guess an artifact filename on the landing page.
- Keep release artifacts, manifest, checksum file, extension ZIP, and source
  archive aligned to the same version tag.
- Check GitHub Releases once per day and ask before opening the official
  release page. Users download and run the new installer themselves while the
  Tauri updater signing key and endpoint remain unset. Never download or
  install a release in the background.

## Landing page content

The page should show the browser-first Google Meet path, desktop-helper path,
local-first handling, the free bring-your-own-key and optional hosted modes,
three clear setup steps, platform downloads, and the separate optional history
server. Downloadable infographics should be real, editable vector files that
the user can print or share.

If the project has no permissioned customer interviews, use clearly labeled
role-based example workflows (such as project leads, recruiters, and
consultants). Do not invent named customers, quotes, outcomes, counts, or
endorsements. Replace examples with testimonials only after the user has
granted permission to publish them.

## Release acceptance

Before calling desktop downloads ready, verify on actual devices that each
installer starts, registers Native Messaging, launches the tray app, and can
complete its platform audio preflight. CI builds and checksums do not prove
these interactions. Keep these OS acceptance results separate from local
source/build gates and live provider checks.

## Superseded work

[`2026-09-21-distribution-and-installation-architecture.md`](2026-09-21-distribution-and-installation-architecture.md)
is retained as a historical design record. Its package-manager-first and
paid-signing assumptions no longer describe the user-facing release plan.
