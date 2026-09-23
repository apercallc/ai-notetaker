param(
    [Parameter(Mandatory = $true)]
    [string] $InstallDir
)

$ErrorActionPreference = 'Stop'

$hostName = 'com.ainotetaker.helper'
$extensionId = 'jidooookkdbbbhkkdmcajnnnhhphodok'
$hostBinary = [IO.Path]::GetFullPath((Join-Path $InstallDir 'notetaker-nm-host.exe'))
$manifestPath = Join-Path $InstallDir "$hostName.json"
$registryPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
)

# Firefox uses a structurally different manifest shape (allowed_extensions
# with a gecko ID, not allowed_origins with a chrome-extension:// URL), so
# it gets its own manifest file and registry key rather than sharing the
# Chromium-family ones above.
$geckoId = 'notetaker@apercallc.dev'
$firefoxManifestPath = Join-Path $InstallDir "$hostName.firefox.json"
$firefoxRegistryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"

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

if (Test-Path -LiteralPath $firefoxManifestPath -PathType Leaf) {
    $existingFirefoxManifest = Get-Content -LiteralPath $firefoxManifestPath -Raw | ConvertFrom-Json
    if ($existingFirefoxManifest.path -ne $hostBinary -or
        @($existingFirefoxManifest.allowed_extensions) -notcontains $geckoId) {
        throw "Refusing to overwrite an unrelated Native Messaging manifest at $firefoxManifestPath"
    }
}

foreach ($registryPath in $registryPaths) {
    if (Test-Path -LiteralPath $registryPath) {
        $existingRegistration = (Get-ItemProperty -LiteralPath $registryPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
        if ($existingRegistration -and $existingRegistration -ne $manifestPath) {
            throw "Refusing to replace a different Native Messaging registration at $registryPath"
        }
    }
}

if (Test-Path -LiteralPath $firefoxRegistryPath) {
    $existingFirefoxRegistration = (Get-ItemProperty -LiteralPath $firefoxRegistryPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    if ($existingFirefoxRegistration -and $existingFirefoxRegistration -ne $firefoxManifestPath) {
        throw "Refusing to replace a different Native Messaging registration at $firefoxRegistryPath"
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

foreach ($registryPath in $registryPaths) {
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -Path $registryPath -Name '(default)' -PropertyType String -Value $manifestPath -Force | Out-Null
}

$firefoxManifest = [ordered]@{
    name = $hostName
    description = 'AI Notetaker desktop helper Native Messaging relay'
    path = $hostBinary
    type = 'stdio'
    allowed_extensions = @($geckoId)
} | ConvertTo-Json -Depth 3

[IO.File]::WriteAllText($firefoxManifestPath, "$firefoxManifest`r`n", $utf8NoBom)
New-Item -Path $firefoxRegistryPath -Force | Out-Null
New-ItemProperty -Path $firefoxRegistryPath -Name '(default)' -PropertyType String -Value $firefoxManifestPath -Force | Out-Null
