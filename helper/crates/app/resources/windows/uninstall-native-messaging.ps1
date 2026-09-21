param(
    [Parameter(Mandatory = $true)]
    [string] $InstallDir
)

$ErrorActionPreference = 'Stop'

$hostName = 'com.ainotetaker.helper'
$extensionId = 'jidooookkdbbbhkkdmcajnnnhhphodok'
$hostBinary = [IO.Path]::GetFullPath((Join-Path $InstallDir 'notetaker-nm-host.exe'))
$manifestPath = Join-Path $InstallDir "$hostName.json"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $allowedOrigins = @($manifest.allowed_origins)
        if ($manifest.path -eq $hostBinary -and $allowedOrigins -contains "chrome-extension://$extensionId/") {
            Remove-Item -LiteralPath $manifestPath -Force
        }
    } catch {
        Write-Warning "AI Notetaker's Native Messaging manifest could not be parsed; leaving it in place: $manifestPath"
    }
}

if (Test-Path -LiteralPath $registryPath) {
    $registeredManifest = (Get-ItemProperty -LiteralPath $registryPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    if ($registeredManifest -eq $manifestPath) {
        Remove-Item -LiteralPath $registryPath -Recurse -Force
    }
}
