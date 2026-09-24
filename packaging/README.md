# Package-manager release channels

The templates in this directory are release outputs, not alternate helper
implementations. They must be rendered from a `published` release manifest
and must reference a signed/checksummed native artifact. Do not replace a
real SHA-256 with `:no_check`, a floating URL, or a download performed by a
package install script.

- `homebrew/` publishes a Cask for the signed macOS app and runs the bundled
  guarded Native Messaging registration helper after the app is staged.
- `winget/` describes the signed Windows installer and its SHA-256.
- `chocolatey/` packages the same signed Windows installer and retains the
  VB-CABLE attribution/donation copy in the native installer.

The Chrome extension is deliberately not packaged here. Normal users install
it from the Chrome Web Store; the release ZIP is only a fallback for managed
or development installations.

Unsigned development installation is documented in
[`../docs/unsigned-install.md`](../docs/unsigned-install.md). The Homebrew
template includes `no_quarantine` only for that development fallback; public
Casks must be regenerated from a signed release manifest.

## Publishing checklist

The repository does not publish these files merely by committing a template.
For a tagged release, the release workflow:

1. builds the native helper on Linux, macOS, and Windows;
2. uploads the installers and checksums to the GitHub Release;
3. renders the pinned Cask, WinGet, and Chocolatey files when the Chrome Web
   Store URL is configured; and
4. leaves external registry submission to the release owner.

Homebrew requires a tap, WinGet requires a reviewed pull request to
`microsoft/winget-pkgs`, and Chocolatey requires an API key. The exact setup,
secrets, and verification commands are in [`../release/README.md`](../release/README.md).
