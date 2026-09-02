[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$hostName = 'com.fansly.mymedia_companion'
$localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
)
$installDirectory = [IO.Path]::GetFullPath(
    (Join-Path $localAppData 'FanslyMyMedia\Companion')
)
$allowedRoot = [IO.Path]::GetFullPath(
    (Join-Path $localAppData 'FanslyMyMedia')
).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $installDirectory.StartsWith(
        $allowedRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to uninstall outside the expected LocalAppData directory."
}

$chromiumManifestPath = Join-Path $installDirectory 'chromium-host.json'
$firefoxManifestPath = Join-Path $installDirectory 'firefox-host.json'
$registrations = @(
    [ordered]@{
        RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
        ManifestPath = $chromiumManifestPath
    }
    [ordered]@{
        RegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
        ManifestPath = $chromiumManifestPath
    }
    [ordered]@{
        RegistryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
        ManifestPath = $firefoxManifestPath
    }
)

foreach ($registration in $registrations) {
    if (-not (Test-Path -LiteralPath $registration.RegistryPath)) {
        continue
    }

    $registeredManifest = (Get-Item -LiteralPath $registration.RegistryPath).GetValue('')
    if ($registeredManifest -eq $registration.ManifestPath) {
        Remove-Item -LiteralPath $registration.RegistryPath
    } else {
        Write-Warning (
            "Kept registration at {0} because it points to a different manifest." -f
                $registration.RegistryPath
        )
    }
}

$ownedFiles = @(
    'fansly-mymedia-host.exe'
    'ffmpeg.exe'
    'ffprobe.exe'
    'chromium-host.json'
    'firefox-host.json'
)

foreach ($fileName in $ownedFiles) {
    $filePath = Join-Path $installDirectory $fileName
    if (Test-Path -LiteralPath $filePath -PathType Leaf) {
        Remove-Item -LiteralPath $filePath
    }
}

if ((Test-Path -LiteralPath $installDirectory -PathType Container) -and
    -not (Get-ChildItem -LiteralPath $installDirectory -Force)) {
    Remove-Item -LiteralPath $installDirectory
}

Write-Host "Uninstalled $hostName."
