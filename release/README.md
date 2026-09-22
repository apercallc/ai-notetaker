# Release metadata

`manifest.json` is the machine-readable contract consumed by the install page
and release automation. It intentionally starts as `unpublished` with no
artifacts; release automation must add real URLs, SHA-256 values, and signing
status before changing it to `published`.

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

Before a Windows release build, set the repository variable
`VB_CABLE_SHA256` to the SHA-256 of the official base VB-CABLE archive. The
workflow refuses to build the Windows helper without that pin and stages the
complete archive only for that build.
