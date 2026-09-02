# Fansly MyMedia companion

Windows 11 native-messaging host for full-quality HLS and DASH downloads. The
browser extension remains the UI; this executable runs only while the browser
has a native-messaging connection open.

## Requirements

- Windows 11 x64
- Bun (build only)
- `ffmpeg.exe` and `ffprobe.exe` from the same trusted FFmpeg distribution

The production layout places `ffmpeg.exe` and `ffprobe.exe` beside
`fansly-mymedia-host.exe`. For development only, their paths can be set with
`FANSLY_MYMEDIA_FFMPEG` and `FANSLY_MYMEDIA_FFPROBE`. Do not put credentials or
signed URLs in these variables.

## Commands

```powershell
npm install
npm run check
npm run build
```

The build is written to `dist/fansly-mymedia-host.exe`. It does not include
FFmpeg. Native-host manifests and Windows registration are maintained by the
project installer.

## Behavior

- Accepts only HTTPS `.m3u8` and `.mpd` URLs on `cdn1.fansly.com` through
  `cdn5.fansly.com`.
- Allows one active download.
- Uses FFprobe to choose the highest-resolution/highest-bitrate video stream
  and highest-bitrate audio stream.
- Uses FFmpeg stream copying, without transcoding.
- Writes to `%USERPROFILE%\Downloads\Fansly MyMedia\<name>.partial` and renames
  the file only after a successful download.
- Removes partial files when a job is cancelled or fails.
- Accepts only the three short-lived CloudFront authorization values required
  for CDN media requests. It never receives unrelated Fansly, device,
  analytics, support, or session cookies. CloudFront values and signed URLs
  remain in memory and are never stored or logged.

MP4 is preferred. A `.mkv` output filename may be used as a lossless fallback
when the source codecs cannot be remuxed into MP4. DRM-protected and encrypted
media is rejected.

## Diagnostics

The host writes redacted JSON-line diagnostics to:

```text
%LOCALAPPDATA%\FanslyMyMedia\Companion\logs\companion.log
```

The log rotates to `companion.previous.log` after reaching 1 MiB. It records
handshakes, tool startup, selected stream indexes, completion, cancellation,
and sanitized FFprobe/FFmpeg failures. Signed URLs and authorization-like
values are removed before writing.

When **Detailed companion diagnostics** is enabled in the extension settings,
the job also records verbose tool output and a bounded, sanitized manifest
response. Debug mode never disables credential redaction.

## Native-messaging protocol

Messages use the browser native-messaging format: a four-byte little-endian
payload length followed by UTF-8 JSON. `stdout` is reserved exclusively for
framed protocol messages.

Requests:

- `{ "type": "hello", "requestId": "..." }`
- `{ "type": "download.start", "requestId": "...", "job": { ... } }`
- `{ "type": "download.cancel", "requestId": "...", "jobId": "..." }`

The host responds to every valid request and emits download progress,
completion, failure, or cancellation events. Signed URLs are intentionally not
included in responses or diagnostics.
