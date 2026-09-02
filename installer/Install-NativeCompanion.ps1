[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $SourceDirectory,

    [ValidateScript({ [string]::IsNullOrEmpty($_) -or $_ -match '^[a-p]{32}$' })]
    [string] $ChromeExtensionId = '',

    [ValidateScript({ [string]::IsNullOrEmpty($_) -or $_ -match '^[a-p]{32}$' })]
    [string] $EdgeExtensionId = '',

    [ValidatePattern('^[A-Za-z0-9._@{}-]+$')]
    [string] $FirefoxExtensionId = 'fansly-mymedia-extension@local',

    [switch] $SkipChrome,

    [switch] $SkipEdge,

    [switch] $SkipFirefox
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$hostName = 'com.fansly.mymedia_companion'
$hostExecutableName = 'fansly-mymedia-host.exe'
$requiredFiles = @($hostExecutableName, 'ffmpeg.exe', 'ffprobe.exe')
$localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
)
$installDirectory = [IO.Path]::GetFullPath(
    (Join-Path $localAppData 'FanslyMyMedia\Companion')
)
$allowedRoot = [IO.Path]::GetFullPath(
    (Join-Path $localAppData 'FanslyMyMedia')
).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $SkipChrome -and [string]::IsNullOrWhiteSpace($ChromeExtensionId)) {
    throw 'ChromeExtensionId is required unless SkipChrome is supplied.'
}
if ($SkipChrome -and $SkipEdge -and $SkipFirefox) {
    throw 'At least one browser must be registered.'
}
if (-not $SkipEdge -and [string]::IsNullOrWhiteSpace($EdgeExtensionId)) {
    throw 'EdgeExtensionId is required unless SkipEdge is supplied.'
}

if (-not $installDirectory.StartsWith(
        $allowedRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to install outside the expected LocalAppData directory."
}

$resolvedSource = Resolve-Path -LiteralPath $SourceDirectory -ErrorAction Stop
if (-not (Test-Path -LiteralPath $resolvedSource.Path -PathType Container)) {
    throw "SourceDirectory must point to a directory: $SourceDirectory"
}

foreach ($fileName in $requiredFiles) {
    $sourceFile = Join-Path $resolvedSource.Path $fileName
    if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
        throw "Required companion file is missing: $sourceFile"
    }
}

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null

foreach ($fileName in $requiredFiles) {
    Copy-Item `
        -LiteralPath (Join-Path $resolvedSource.Path $fileName) `
        -Destination (Join-Path $installDirectory $fileName) `
        -Force
}

$hostExecutablePath = Join-Path $installDirectory $hostExecutableName
$chromiumManifestPath = Join-Path $installDirectory 'chromium-host.json'
$firefoxManifestPath = Join-Path $installDirectory 'firefox-host.json'

$allowedOrigins = @()
if (-not $SkipChrome) {
    $allowedOrigins += "chrome-extension://$ChromeExtensionId/"
}
if (-not $SkipEdge) {
    $allowedOrigins += "chrome-extension://$EdgeExtensionId/"
}

$chromiumManifest = [ordered]@{
    name = $hostName
    description = 'Fansly MyMedia native download companion'
    path = $hostExecutablePath
    type = 'stdio'
    allowed_origins = $allowedOrigins
}

$firefoxManifest = [ordered]@{
    name = $hostName
    description = 'Fansly MyMedia native download companion'
    path = $hostExecutablePath
    type = 'stdio'
    allowed_extensions = @($FirefoxExtensionId)
}

$registrations = @()
$utf8WithoutBom = [Text.UTF8Encoding]::new($false)
if (-not $SkipChrome -or -not $SkipEdge) {
    $chromiumJson = $chromiumManifest | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText(
        $chromiumManifestPath,
        $chromiumJson,
        $utf8WithoutBom
    )
}
if (-not $SkipFirefox) {
    $firefoxJson = $firefoxManifest | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText(
        $firefoxManifestPath,
        $firefoxJson,
        $utf8WithoutBom
    )
}

if (-not $SkipChrome) {
    $registrations += [ordered]@{
        RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
        ManifestPath = $chromiumManifestPath
    }
}
if (-not $SkipEdge) {
    $registrations += [ordered]@{
        RegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
        ManifestPath = $chromiumManifestPath
    }
}
if (-not $SkipFirefox) {
    $registrations += [ordered]@{
        RegistryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
        ManifestPath = $firefoxManifestPath
    }
}

foreach ($registration in $registrations) {
    New-Item -Path $registration.RegistryPath -Force | Out-Null
    Set-Item `
        -LiteralPath $registration.RegistryPath `
        -Value $registration.ManifestPath
}

Write-Host "Installed $hostName in $installDirectory"
Write-Host 'Restart each registered browser before testing the extension.'
