# Release metadata

`manifest.json` is the machine-readable contract consumed by the install page
and release automation. The checked-in file intentionally starts as
`unpublished` with no artifacts. A tagged build generates a release manifest
from the actual files, computes SHA-256 values, and uploads it beside the
installers. It becomes `published` only when both the Chrome Web Store URL and
the explicit release-owner signing confirmation are provided.

The release workflow also checks that the manifest version matches the helper
Cargo workspace, the extension manifest, and the webapp package before any
native build starts.

Validate it with:

```sh
node scripts/validate-release-manifest.mjs release/manifest.json
```

Package-manager templates live under `packaging/`. They are rendered only
from a published manifest so an unreleased build cannot accidentally publish
an unpinned installer.

## First public release checklist

1. Submit the project to the free [SignPath Foundation](https://signpath.org/apply)
   program and configure the approved project/policy plus GitHub Actions
   integration when accepted. Keep the application and approval status
   separate from local signing claims.
2. Create the native signing prerequisites described in
   [`../docs/helper-packaging.md`](../docs/helper-packaging.md): Apple signing
   and notarization, Windows Authenticode, the VB-CABLE checksum, and the
   Tauri updater key kept outside the repository.
3. Publish the extension in the Chrome Web Store and add its URL as the
   repository variable `CHROME_WEB_STORE_URL`. Set
   `RELEASE_SIGNING_CONFIRMED=true` only after the native signing and
   notarization checks have passed.
4. Update all four package versions together, run the release-floor checks,
   and push a tag such as `v0.1.0`.
5. Confirm the `Release build` workflow creates the GitHub Release, native
   assets, `manifest.json`, and `SHA256SUMS`. A successful CI build alone is
   not proof of a real OS install or meeting capture.
6. Submit the rendered package files:
   - Homebrew Cask: publish `homebrew/Casks/ai-notetaker.rb` in the maintained
     `homebrew-*` tap and test `brew install --cask ai-notetaker` plus upgrade.
   - WinGet: submit `winget/AI.Notetaker.yaml` to `microsoft/winget-pkgs` and
     wait for review before documenting `winget install` as available.
   - Chocolatey: package the rendered `.nuspec` and `tools/` files, run
     `choco pack`, then `choco push` with the owner API key.
7. Install and upgrade once on each native OS, then test the Chrome Web Store
   extension against the exact helper version before calling the channel
   public.

Unsigned development installs are allowed only through
[`../docs/unsigned-install.md`](../docs/unsigned-install.md). The signing
policy and the limited Homebrew `no_quarantine` fallback are documented in
[`../docs/code-signing-policy.md`](../docs/code-signing-policy.md).

## Container publishing

The tagged release workflow publishes the optional webapp image to
`ghcr.io/apercallc/ai-notetaker-webapp:<tag>` and `:latest`. GitHub Container
Registry uses the repository's `GITHUB_TOKEN`; the package must be made public
after the first push. Docker Hub is an optional mirror, not a second helper
distribution. Set the repository variable `DOCKERHUB_NAMESPACE` and secrets
`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` to enable the mirror job. Users can then
set `AI_NOTETAKER_WEBAPP_IMAGE` to
`docker.io/<namespace>/ai-notetaker-webapp:<tag>` in `docker-compose.registry.yml`.

The image contains only the self-hosted history server. The desktop helper
cannot be moved into Docker because it needs the host's audio devices and
Chrome Native Messaging registration.

Before a Windows release build, set the repository variable
`VB_CABLE_SHA256` to the SHA-256 of the official base VB-CABLE archive. The
workflow refuses to build the Windows helper without that pin and stages the
complete archive only for that build.
