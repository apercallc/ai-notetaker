param(
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedSha256
)

$ErrorActionPreference = 'Stop'

$downloadUrl = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'
if ($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'ExpectedSha256 must be a 64-character SHA-256 value from the release owner'
}

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "ai-notetaker-vb-cable-$([Guid]::NewGuid().ToString('N'))"
$archivePath = Join-Path $temporaryDirectory 'VBCABLE_Driver_Pack45.zip'
$extractDirectory = Join-Path $temporaryDirectory 'extracted'

try {
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
    if ($actualSha256 -ine $ExpectedSha256) {
        throw "VB-CABLE archive checksum mismatch. Expected $ExpectedSha256, received $actualSha256"
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDirectory -Force
    if (-not (Get-ChildItem -LiteralPath $extractDirectory -Filter 'VBCABLE_Setup_x64.exe' -File -Recurse | Select-Object -First 1)) {
        throw 'The pinned VB-CABLE archive did not contain VBCABLE_Setup_x64.exe'
    }

    if (Test-Path -LiteralPath $OutputDirectory) {
        Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    Copy-Item -Path (Join-Path $extractDirectory '*') -Destination $OutputDirectory -Recurse -Force

    $stagedInstaller = Get-ChildItem -LiteralPath $OutputDirectory -Filter 'VBCABLE_Setup_x64.exe' -File -Recurse | Select-Object -First 1
    if (-not $stagedInstaller) {
        throw 'The VB-CABLE payload was extracted but could not be staged'
    }
    Write-Output "Staged the checksum-verified base VB-CABLE package at $OutputDirectory"
} finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
