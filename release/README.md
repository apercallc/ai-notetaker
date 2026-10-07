# Direct-download release metadata

`manifest.json` is the machine-readable contract consumed by the install page
and release automation. The checked-in file starts as `unpublished` with no
artifacts. A tagged build generates the published manifest from actual release
files and records SHA-256 values. Native artifacts are marked `unsigned`; a
checksum detects corruption but does not verify publisher identity.

The workflow checks that release, helper, extension, and webapp versions
match before it builds native artifacts.

Validate the checked-in manifest with:

```sh
node scripts/validate-release-manifest.mjs release/manifest.json
```

## Release checklist

1. Keep the helper, extension, webapp, and release manifest versions aligned.
2. Push a version tag such as `v0.1.0`. The workflow builds Apple-silicon and
   Intel Mac DMGs, a Windows 64-bit installer, a Linux 64-bit Debian package,
   and a legacy Chrome extension ZIP for existing users.
3. Confirm the GitHub Release has the platform installers, `manifest.json`,
   `SHA256SUMS`, and extension ZIP. Verify the manifest marks the native
   artifacts `unsigned` and checksums match the uploaded files.
4. Install each native artifact on its target OS. CI does not prove installer,
   permissions, audio routing, or meeting capture on a real device.
5. Publish the extension in the Chrome Web Store when ready and add its URL as
   the repository variable `CHROME_WEB_STORE_URL`. Until then the install page
   can link to the fallback ZIP and manual setup instructions.

Read [`../docs/code-signing-policy.md`](../docs/code-signing-policy.md) for the
current unsigned-install prompts and checksum limitations.

Before a Windows release build, set the repository variable `VB_CABLE_SHA256`
to the SHA-256 of the official base VB-CABLE archive. The workflow refuses to
build the Windows helper without that pin and stages the complete archive only
for that build.
