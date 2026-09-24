# Cross-Browser Ports Implementation Plan

Status: Deferred historical plan. The current product target is Chrome-first;
do not treat this document's original no-subscription wording as the current
commercial contract. See the 2026-09-24 Scribbl dual-mode product design.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the built Chrome extension work unmodified in Edge and
Brave (helper-side installer gap only), and add a real, separate Firefox
port (manifest + Native Messaging host manifest variant).

**Architecture:** Extend each existing per-OS Native Messaging installer
script from one hardcoded Chrome path/registry-key to a small array of
`(vendor, path)` pairs, looping the exact same already-reviewed
write/remove logic per vendor. Firefox additionally needs its own
manifest fields and its own Native Messaging host manifest shape
(`allowed_extensions` vs `allowed_origins`).

**Tech Stack:** POSIX shell (macOS/Linux installer scripts), PowerShell
(Windows), JSON (manifests) — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md`

## Global Constraints

- Never overwrite an unrelated Native Messaging manifest — every new
  vendor branch must keep the existing "refuse if path/id doesn't match"
  safety check, per vendor, independently.
- The Chrome branch of every script must be functionally unchanged —
  diff review should show pure addition, not modification, of the
  existing Chrome logic.
- Firefox's `gecko.id` is permanent once chosen (`notetaker@apercallc.dev`
  per the spec) — treat it with the same care as the Chrome `key` field
  (`extension/CLAUDE.md`).

---

### Task 1: Edge and Brave on macOS

**Files:**
- Modify: `helper/crates/app/scripts/macos/install-native-messaging.sh`
- Modify: `helper/crates/app/scripts/macos/uninstall-native-messaging.sh`

**Interfaces:** None — standalone shell scripts invoked by the macOS
installer flow (`docs/helper-packaging.md`), no Rust/TS callers to update.

- [ ] **Step 1: Read both scripts in full**

Run: `cat helper/crates/app/scripts/macos/install-native-messaging.sh helper/crates/app/scripts/macos/uninstall-native-messaging.sh`

- [ ] **Step 2: Refactor `install-native-messaging.sh` to loop over vendors**

Replace the single `manifest_dir=...` / write block with a loop over
three `(vendor, dir)` pairs, keeping the exact existing safety-check and
atomic-write logic per iteration:

```sh
#!/bin/sh
set -eu

app_path=${1:-/Applications/AI Notetaker.app}
host_name='com.ainotetaker.helper'
extension_id='jidooookkdbbbhkkdmcajnnnhhphodok'

if [ "${app_path#/}" = "$app_path" ]; then
    app_path=$(cd "$app_path" && pwd -P)
fi

host_binary="$app_path/Contents/MacOS/notetaker-nm-host"

if [ ! -x "$host_binary" ]; then
    echo "Native Messaging host was not found or is not executable: $host_binary" >&2
    exit 1
fi

install_for_vendor() {
    vendor_dir=$1
    manifest_dir="$HOME/Library/Application Support/$vendor_dir/NativeMessagingHosts"
    manifest_path="$manifest_dir/$host_name.json"

    if [ -e "$manifest_path" ] && {
        ! grep -Fq "chrome-extension://$extension_id/" "$manifest_path" ||
        ! grep -Fq "\"path\": \"$host_binary\"" "$manifest_path";
    }; then
        echo "Refusing to overwrite an unrelated Native Messaging manifest: $manifest_path" >&2
        return 1
    fi

    umask 022
    mkdir -p "$manifest_dir"
    temporary_path=$(mktemp "$manifest_dir/.$host_name.json.XXXXXX")
    trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
    printf '%s\n' "{\"name\":\"$host_name\",\"description\":\"AI Notetaker desktop helper Native Messaging relay\",\"path\":\"$host_binary\",\"type\":\"stdio\",\"allowed_origins\":[\"chrome-extension://$extension_id/\"]}" > "$temporary_path"
    chmod 644 "$temporary_path"
    mv -f "$temporary_path" "$manifest_path"
    trap - EXIT HUP INT TERM
}

for vendor_dir in "Google/Chrome" "Microsoft Edge" "BraveSoftware/Brave-Browser"; do
    install_for_vendor "$vendor_dir"
done
```

Note this is a straight refactor of the existing single-vendor body into
a function called once per vendor — the Chrome iteration produces byte-
identical output to the current script.

- [ ] **Step 3: Refactor `uninstall-native-messaging.sh` the same way**

Read the current uninstall script first (it mirrors the install script's
structure — remove the manifest only if it matches this host). Apply the
same "extract to a function, loop over the three vendor dirs" refactor.

- [ ] **Step 4: Manually verify the script is syntactically valid**

Run: `sh -n helper/crates/app/scripts/macos/install-native-messaging.sh && sh -n helper/crates/app/scripts/macos/uninstall-native-messaging.sh`
Expected: no output (both parse cleanly). This project has no macOS
runner in this sandbox to execute the script for real — `sh -n` (syntax
check only) plus careful review is the available verification, matching
the spec's documented testing approach.

- [ ] **Step 5: Commit**

```bash
git add helper/crates/app/scripts/macos/install-native-messaging.sh helper/crates/app/scripts/macos/uninstall-native-messaging.sh
git commit -m "feat: register Native Messaging host for Edge and Brave on macOS"
```

---

### Task 2: Edge and Brave on Windows

**Files:**
- Modify: `helper/crates/app/resources/windows/install-native-messaging.ps1`
- Modify: `helper/crates/app/resources/windows/uninstall-native-messaging.ps1`

- [ ] **Step 1: Read both scripts in full**

Run: `cat helper/crates/app/resources/windows/install-native-messaging.ps1 helper/crates/app/resources/windows/uninstall-native-messaging.ps1`

- [ ] **Step 2: Refactor the install script to loop over registry vendor paths**

```powershell
param(
    [Parameter(Mandatory = $true)]
    [string] $InstallDir
)

$ErrorActionPreference = 'Stop'

$hostName = 'com.ainotetaker.helper'
$extensionId = 'jidooookkdbbbhkkdmcajnnnhhphodok'
$hostBinary = [IO.Path]::GetFullPath((Join-Path $InstallDir 'notetaker-nm-host.exe'))
$manifestPath = Join-Path $InstallDir "$hostName.json"

if (-not (Test-Path -LiteralPath $hostBinary -PathType Leaf)) {
    throw "Native Messaging host was not found at $hostBinary"
}

if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $existingManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($existingManifest.path -ne $hostBinary -or
        @($existingManifest.allowed_origins) -notcontains "chrome-extension://$extensionId/") {
        throw "Refusing to overwrite an unrelated Native Messaging manifest at $manifestPath"
    }
}

$manifest = [ordered]@{
    name = $hostName
    description = 'AI Notetaker desktop helper Native Messaging relay'
    path = $hostBinary
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 3

$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
[IO.File]::WriteAllText($manifestPath, "$manifest`r`n", $utf8NoBom)

$registryPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
)

foreach ($registryPath in $registryPaths) {
    if (Test-Path -LiteralPath $registryPath) {
        $existingRegistration = (Get-ItemProperty -LiteralPath $registryPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
        if ($existingRegistration -and $existingRegistration -ne $manifestPath) {
            throw "Refusing to replace a different Native Messaging registration at $registryPath"
        }
    }
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -Path $registryPath -Name '(default)' -PropertyType String -Value $manifestPath -Force | Out-Null
}
```

Note: all three browsers share **one** manifest file (`$manifestPath`,
already the case for Chrome today) since Windows Native Messaging looks
up the manifest path from the registry per-browser, not from a
browser-specific directory — only the registry key differs per vendor,
unlike macOS/Linux where each vendor has its own directory. This matches
how the existing single-manifest/single-registry-key Chrome behavior
already works; we're just adding two more registry keys pointing at the
same file.

- [ ] **Step 3: Refactor the uninstall script similarly** — read it
      first, then loop its existing single-key removal logic over the
      same three registry paths, and only remove the shared manifest file
      once all three registry entries have been removed.

- [ ] **Step 4: Verify PowerShell syntax**

Run: `pwsh -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('helper/crates/app/resources/windows/install-native-messaging.ps1', [ref]$null, [ref]$errors); if ($errors) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }"` if `pwsh` is available in this environment; otherwise note in the commit that syntax was verified by careful manual review only (no Windows/PowerShell runtime in this sandbox — matches the spec's documented release-owner verification gate).

- [ ] **Step 5: Commit**

```bash
git add helper/crates/app/resources/windows/install-native-messaging.ps1 helper/crates/app/resources/windows/uninstall-native-messaging.ps1
git commit -m "feat: register Native Messaging host for Edge and Brave on Windows"
```

---

### Task 3: Edge and Brave on Linux

**Files:**
- Modify: `helper/crates/app/scripts/debian/postinst`
- Modify: `helper/crates/app/scripts/debian/postrm`

- [ ] **Step 1: Read both scripts in full**

Run: `cat helper/crates/app/scripts/debian/postinst helper/crates/app/scripts/debian/postrm`

- [ ] **Step 2: Add two more `write_manifest` calls to `postinst`**

The script already defines a reusable `write_manifest()` function called
twice (Chrome, generic Chromium). Add two more calls at the bottom:

```sh
write_manifest '/etc/opt/chrome/native-messaging-hosts'
write_manifest '/etc/chromium/native-messaging-hosts'
write_manifest '/etc/opt/microsoft/msedge/native-messaging-hosts'
write_manifest '/etc/brave/native-messaging-hosts'
```

- [ ] **Step 3: Mirror the same two extra paths in `postrm`**

Read `postrm` first to find its equivalent removal-loop structure, then
add the same two directories to it.

- [ ] **Step 4: Syntax-check both scripts**

Run: `sh -n helper/crates/app/scripts/debian/postinst && sh -n helper/crates/app/scripts/debian/postrm`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add helper/crates/app/scripts/debian/postinst helper/crates/app/scripts/debian/postrm
git commit -m "feat: register Native Messaging host for Edge and Brave on Linux"
```

---

### Task 4: Documentation for Phase A

**Files:**
- Modify: `docs/getting-started.md`
- Modify: `docs/helper-packaging.md`

- [ ] **Step 1: Read both docs' existing Chrome install sections**

Run: `grep -n "Chrome Web Store\|Load unpacked\|chrome://extensions" docs/getting-started.md docs/helper-packaging.md`

- [ ] **Step 2: Add an Edge/Brave subsection**

Directly under the existing Chrome installation step in
`docs/getting-started.md`, add:

```markdown
### Using Edge or Brave instead of Chrome

The same extension build works in Edge and Brave (both are Chromium-based
and implement the same extension APIs). Since it isn't published to
Edge Add-ons or listed for Brave, load it manually:

1. Download or build the extension (`dist/` from `extension/`, or the
   released ZIP).
2. Edge: go to `edge://extensions`, enable **Developer mode**, click
   **Load unpacked**, select the `dist/` folder.
   Brave: go to `brave://extensions`, enable **Developer Mode**, click
   **Load unpacked**, select the `dist/` folder.
3. Install the desktop helper as normal — its installer now registers the
   Native Messaging host for Edge and Brave automatically, alongside
   Chrome.
```

- [ ] **Step 3: Commit**

```bash
git add docs/getting-started.md docs/helper-packaging.md
git commit -m "docs: add Edge/Brave manual install instructions"
```

---

### Task 5: Firefox extension manifest

**Files:**
- Modify: `extension/manifest.json`
- Test: `extension/tests/manifest.test.ts` (new file)

**Interfaces:** None — manifest-only change, no code consumes these new
fields at build time.

- [ ] **Step 1: Write the failing manifest-shape test**

Create `extension/tests/manifest.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";

describe("manifest.json cross-browser fields", () => {
  it("declares a permanent Firefox gecko extension id", () => {
    expect(manifest.browser_specific_settings?.gecko?.id).toBe("notetaker@apercallc.dev");
  });

  it("declares background.scripts for Firefox alongside service_worker for Chrome/Edge/Brave", () => {
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.scripts).toEqual(["background.js"]);
  });
});
```

Run: `cd extension && npm test -- manifest`
Expected: FAIL — `manifest.json` has neither field yet, and TypeScript's
JSON import typing will also flag `browser_specific_settings` as unknown
(the test file casts loosely via optional chaining so it fails at the
`toBe`/`toEqual` assertion, not at compile time).

- [ ] **Step 2: Add the fields to `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "AI Notetaker",
  "short_name": "Notetaker",
  "description": "Botless meeting notes with free local BYOK or optional hosted AI.",
  "version": "0.1.0",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4K2Qmk5RfHSNTe7xD+KH626c5l6kNO7FpEiLNpdjnmxR7grcXy5wFIddPzg/aQKlQX4rKHpUz5lH6WUkZ0M6hdl7aLAmCWwb1FoK/s50BkL+9OcNUhIWFG41HgLmwf3RAGfAFI1wagJ/T4yYJOyamtU7wppGPYEQqLRU1lBN/x47GQC/yU5PQhcta3C+eAqALfvfNuXQZS0ud1E4Mj0PFBvXGVfyeBO/AoxiW4RL2CgJFzR8F0rg5ZU2w8VsuI+TVlh56CA0ZsVSZ4Y9LzbjaJrwftIQNVYls0lvwC5hOGgf8Z+XxKeMBNwepYEPaFJCRU+uBTJJXDNm/8ELyarIBQIDAQAB",
  "browser_specific_settings": {
    "gecko": {
      "id": "notetaker@apercallc.dev",
      "strict_min_version": "121.0"
    }
  },
  "permissions": ["storage", "nativeMessaging", "alarms"],
  "background": {
    "service_worker": "background.js",
    "scripts": ["background.js"],
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "options_page": "settings/settings.html",
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

(`strict_min_version: "121.0"` matches the Firefox version where a single
manifest declaring both `service_worker` and `scripts` behaves correctly
per the researched Mozilla migration guidance — older Firefox releases
are out of scope.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd extension && npm test -- manifest`
Expected: PASS

- [ ] **Step 4: Run the full extension suite, typecheck, and build**

Run: `cd extension && npm test && npm run typecheck && npm run build`
Expected: all PASS. `background.js` is still built exactly as before —
this task only changes `manifest.json`.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/tests/manifest.test.ts
git commit -m "feat: add Firefox manifest fields (gecko id, background.scripts)"
```

---

### Task 6: Firefox Native Messaging host manifest + installer branches

**Files:**
- Create: `helper/native-messaging-host-manifest/com.ainotetaker.helper.firefox.json.template`
- Modify: `helper/native-messaging-host-manifest/README.md`
- Modify: `helper/crates/app/scripts/macos/install-native-messaging.sh` / `uninstall-native-messaging.sh`
- Modify: `helper/crates/app/resources/windows/install-native-messaging.ps1` / `uninstall-native-messaging.ps1`
- Modify: `helper/crates/app/scripts/debian/postinst` / `postrm`

**Interfaces:** None — same standalone-script pattern as Tasks 1-3.

- [ ] **Step 1: Add the Firefox host manifest template**

```json
{
  "name": "com.ainotetaker.helper",
  "description": "AI Notetaker desktop helper — bridges the Firefox extension to the local capture/pipeline process",
  "path": "__NM_HOST_BINARY_PATH__",
  "type": "stdio",
  "allowed_extensions": ["notetaker@apercallc.dev"]
}
```

- [ ] **Step 2: Document it in the README**

Add a section to `helper/native-messaging-host-manifest/README.md`
explaining the Firefox variant exists because Firefox's manifest shape
uses `allowed_extensions` (a gecko ID) instead of `allowed_origins` (a
`chrome-extension://` URL), and lists the three Firefox-specific OS
locations from the spec (macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/`;
Linux: `/usr/lib/mozilla/native-messaging-hosts/`; Windows registry:
`HKCU:\Software\Mozilla\NativeMessagingHosts\<name>`).

- [ ] **Step 3: Add the Firefox branch to the macOS scripts**

In `install-native-messaging.sh`, add a second `install_for_vendor`-style
function (or a parameter for the manifest shape) specifically for
Firefox, since its JSON body differs (`allowed_extensions` array with the
gecko ID, not `allowed_origins` with the extension ID):

```sh
install_firefox() {
    manifest_dir="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    manifest_path="$manifest_dir/$host_name.json"
    gecko_id='notetaker@apercallc.dev'

    if [ -e "$manifest_path" ] && {
        ! grep -Fq "\"$gecko_id\"" "$manifest_path" ||
        ! grep -Fq "\"path\": \"$host_binary\"" "$manifest_path";
    }; then
        echo "Refusing to overwrite an unrelated Native Messaging manifest: $manifest_path" >&2
        return 1
    fi

    umask 022
    mkdir -p "$manifest_dir"
    temporary_path=$(mktemp "$manifest_dir/.$host_name.json.XXXXXX")
    trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
    printf '%s\n' "{\"name\":\"$host_name\",\"description\":\"AI Notetaker desktop helper Native Messaging relay\",\"path\":\"$host_binary\",\"type\":\"stdio\",\"allowed_extensions\":[\"$gecko_id\"]}" > "$temporary_path"
    chmod 644 "$temporary_path"
    mv -f "$temporary_path" "$manifest_path"
    trap - EXIT HUP INT TERM
}
```

Call `install_firefox` alongside the Chromium-family loop from Task 1.
Mirror the same addition (matching removal logic) in
`uninstall-native-messaging.sh`.

- [ ] **Step 4: Add the Firefox branch to the Windows scripts**

Same shape difference (`allowed_extensions` vs `allowed_origins`) applies
to the PowerShell manifest object and its validation check. Add a
separate manifest file (Firefox needs its own file since its JSON body
differs from the Chromium-family one, unlike Edge/Brave which share
Chrome's file) at `Join-Path $InstallDir "com.ainotetaker.helper.firefox.json"`,
and one more registry key:
`HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName` pointing at that
Firefox-specific file.

- [ ] **Step 5: Add the Firefox branch to `postinst`/`postrm`**

Add a `write_firefox_manifest` function (same `allowed_extensions` shape)
called with `/usr/lib/mozilla/native-messaging-hosts`, and its matching
removal in `postrm`.

- [ ] **Step 6: Syntax-check every modified script**

Run: `sh -n helper/crates/app/scripts/macos/install-native-messaging.sh helper/crates/app/scripts/macos/uninstall-native-messaging.sh helper/crates/app/scripts/debian/postinst helper/crates/app/scripts/debian/postrm`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add helper/native-messaging-host-manifest/ helper/crates/app/scripts/macos/install-native-messaging.sh helper/crates/app/scripts/macos/uninstall-native-messaging.sh helper/crates/app/resources/windows/install-native-messaging.ps1 helper/crates/app/resources/windows/uninstall-native-messaging.ps1 helper/crates/app/scripts/debian/postinst helper/crates/app/scripts/debian/postrm
git commit -m "feat: register a Firefox-shaped Native Messaging host manifest"
```

---

### Task 7: Firefox documentation + TODO update

**Files:**
- Modify: `docs/getting-started.md`
- Modify: `TODO.md`

- [ ] **Step 1: Add a Firefox subsection to `docs/getting-started.md`**

```markdown
### Using Firefox

Firefox support is real (its own manifest fields and Native Messaging
host manifest shape — see
`docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md`), but
the extension isn't signed by Mozilla yet, so it only loads temporarily:

1. Build the extension (`dist/` from `extension/`).
2. Go to `about:debugging` → **This Firefox** → **Load Temporary
   Add-on…** → select any file inside `dist/` (e.g. `manifest.json`).
3. This resets every time Firefox restarts until the extension is signed
   and published via addons.mozilla.org (release-owner work).
4. Install the desktop helper as normal — its installer registers the
   Firefox-specific Native Messaging host manifest automatically.
```

- [ ] **Step 2: Update `TODO.md`**

Find:

```
- [ ] Cross-browser ports: Edge and Brave first (near-zero-cost, same
      Manifest V3 base), Firefox as a real port (different extension APIs)
```

Replace with:

```
- [x] Cross-browser ports — Edge/Brave: helper now registers its Native
      Messaging host in both browsers' OS-specific locations (the actual
      gap; the extension code needed no changes). Firefox: real port —
      `browser_specific_settings.gecko.id`, `background.scripts`
      alongside `service_worker`, and a separate Native Messaging host
      manifest shape (`allowed_extensions`, not `allowed_origins`). See
      `docs/superpowers/specs/2026-09-22-cross-browser-ports-design.md`.
      Actually loading in real Edge/Brave/Firefox installs, and Mozilla
      AMO signing, remain release-owner validation.
```

- [ ] **Step 3: Commit**

```bash
git add docs/getting-started.md TODO.md
git commit -m "docs: add Firefox install instructions, mark cross-browser ports done"
```
