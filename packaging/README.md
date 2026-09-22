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
