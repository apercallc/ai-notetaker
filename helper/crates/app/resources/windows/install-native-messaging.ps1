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

foreach ($registryPath in $registryPaths) {
    if (Test-Path -LiteralPath $registryPath) {
        $existingRegistration = (Get-ItemProperty -LiteralPath $registryPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
        if ($existingRegistration -and $existingRegistration -ne $manifestPath) {
            throw "Refusing to replace a different Native Messaging registration at $registryPath"
        }
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
