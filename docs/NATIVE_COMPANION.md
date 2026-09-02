# Windows native companion (experimental fallback)

> The Chrome extension no longer invokes this companion. Full-quality HLS
> downloads now run in the extension library page and write directly
> to a user-selected directory. This document is retained for debugging and
> possible fallback use only.

The optional native companion downloads user-selected HLS and DASH videos at
their highest accessible quality. The extension remains the UI; the companion
is a headless Windows 11 x64 process started by Chrome, Edge, or Firefox through
native messaging. Direct image and MP4 downloads continue to work without it.

The host is registered as `com.fansly.mymedia_companion`. It uses FFprobe to
inspect manifests and FFmpeg to download and remux their selected video and
audio streams. It does not run a web server or install a Windows service.

## Prerequisites

- Windows 11 x64
- Node.js and npm for the project tooling
- Bun as required by the companion build script
- A Windows x64 FFmpeg distribution containing `ffmpeg.exe` and `ffprobe.exe`
- The unpacked or published extension ID for every Chromium browser being
  registered

Use an FFmpeg build from a source you trust and verify its checksum. FFmpeg
licensing depends on its build configuration. Keep the distributor's license
and source offer with redistributed binaries, and review the
[FFmpeg legal guidance](https://ffmpeg.org/legal.html). In particular, enabling
GPL components changes the obligations compared with an LGPL build.

## Build

From the repository root:

```powershell
Set-Location .\companion
npm install
npm run build
```

The build contract is `companion\dist\fansly-mymedia-host.exe`. Before running
the installer, place the following three files in one staging directory:

```text
fansly-mymedia-host.exe
ffmpeg.exe
ffprobe.exe
```

For example, copy the FFmpeg tools into `companion\dist`. The installer checks
all three files before changing the installation.

## Obtain extension IDs

For Chrome, open `chrome://extensions`, enable Developer mode, load the Chrome
build unpacked, and copy its ID. For Edge, use `edge://extensions`. Unpacked IDs
may change if the extension is loaded from a different build or without a fixed
manifest key, so reinstall the native registration when the ID changes.

Firefox uses the declared add-on ID
`fansly-mymedia-extension@local`. A temporary extension loaded from
`about:debugging` must retain that manifest ID for native messaging to match.

## Install for the current user

Close the browsers before installation. The default command registers all three
browsers and therefore requires both Chromium IDs:

```powershell
.\installer\Install-NativeCompanion.ps1 `
    -SourceDirectory .\companion\dist `
    -ChromeExtensionId '<32-character Chrome ID>' `
    -EdgeExtensionId '<32-character Edge ID>'
```

Skip browsers that are not being tested. The corresponding ID is then not
required:

```powershell
.\installer\Install-NativeCompanion.ps1 `
    -SourceDirectory .\companion\dist `
    -ChromeExtensionId '<32-character Chrome ID>' `
    -SkipEdge `
    -SkipFirefox
```

The script copies the three executables to
`%LOCALAPPDATA%\FanslyMyMedia\Companion`, writes separate Chromium and Firefox
host manifests there, and creates only these current-user registrations:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.fansly.mymedia_companion
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.fansly.mymedia_companion
HKCU\Software\Mozilla\NativeMessagingHosts\com.fansly.mymedia_companion
```

No administrator access is required. Chromium manifests use `allowed_origins`;
the Firefox manifest uses `allowed_extensions`. These formats are intentionally
separate.

## Manual test

1. Restart the registered browser after installation.
2. Load the matching extension build and open Fansly.
3. Open the extension media library and verify that companion status reports a
   successful version/capability handshake.
4. Select one accessible HLS or DASH video and start its companion download.
5. Confirm that progress changes, a partial file is used while downloading, and
   only the completed final file appears in download history.
6. Start another small test and cancel it. It must not be marked completed.
7. Close or disable the companion and confirm that direct image/MP4 downloads
   still work and streaming downloads show an actionable unavailable error.

Do not test by typing JSON directly into the executable. Native messaging uses
four-byte length-prefixed messages on standard input and output. Arbitrary text
is not a valid protocol frame, and the host reserves standard output exclusively
for framed protocol messages.

Registration can be inspected without changing it:

```powershell
Get-ItemProperty `
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fansly.mymedia_companion'
```

Change the vendor path to `Microsoft\Edge` or `Mozilla` for those browsers.

### Companion diagnostics

The companion writes redacted JSON-line diagnostics here:

```text
%LOCALAPPDATA%\FanslyMyMedia\Companion\logs\companion.log
```

Follow the log while testing from PowerShell:

```powershell
Get-Content `
    "$env:LOCALAPPDATA\FanslyMyMedia\Companion\logs\companion.log" `
    -Wait
```

The previous 1 MiB log is retained as `companion.previous.log`. Diagnostics
include the handshake, FFprobe and FFmpeg startup, selected stream indexes,
completion, cancellation, and redacted failures. Signed manifest URLs and
authorization-like values are never written.

Enable **Detailed companion diagnostics** in the extension settings before
starting a test download to additionally record verbose FFprobe/FFmpeg output,
the manifest HTTP status and safe response headers, and up to 64 KiB of the
sanitized manifest response. The persisted toggle applies to subsequent jobs.
Full URLs, signed query values, cookies, and authorization values remain
redacted even in this mode.

## Download and security behavior

- The extension sends only an explicitly selected manifest and sanitized output
  metadata.
- The extension reads only `CloudFront-Key-Pair-Id`, `CloudFront-Policy`, and
  `CloudFront-Signature` for the selected CDN URL and passes them transiently
  to the companion. It does not forward Fansly session, device, analytics, or
  support cookies.
- CloudFront authorization values are held in memory for the active job and
  never persisted or included in logs.
- Signed CDN URLs are short-lived and are never persisted. Logs redact their
  query strings.
- The native manifests allow only the supplied extension IDs.
- DRM or encrypted streams are rejected; the companion does not bypass access
  controls.
- Successful downloads are written to a partial file and finalized only after
  FFmpeg exits successfully.

Pausing the queue prevents a new job from starting. In the initial release, an
active FFmpeg job can be cancelled but not reliably suspended and resumed. A
signed manifest may expire while suspended, so active-download resume requires
a later design that refreshes URLs and persists safe segment state.

## Uninstall

Close the browsers, then run:

```powershell
.\installer\Uninstall-NativeCompanion.ps1
```

The uninstaller removes a registry key only when it still points to this
project's expected manifest. It removes only the known companion files and
leaves the installation directory in place if it contains anything else.

## Distribution and code signing

Locally built unsigned executables can trigger Microsoft Defender SmartScreen.
For distribution, sign the host, installer, FFmpeg, and FFprobe artifacts with
an appropriate Authenticode certificate after producing the final binaries.
Publish SHA-256 checksums and verify signatures before installation. Signing
does not replace the native-host extension allowlist or runtime input
validation.

Keep the exact FFmpeg build version, configuration, license texts, source-code
offer or corresponding-source location, Bun/runtime attribution, and companion
source revision with every release. Re-run the integration tests whenever Bun
or FFmpeg is upgraded.

See the browser documentation for platform registration details:

- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Firefox native messaging](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
