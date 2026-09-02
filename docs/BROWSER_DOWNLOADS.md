# Chrome browser-native downloads

The Chrome extension downloads media without a native companion. The service
worker validates each selected item, stores its signed source URL only in
`chrome.storage.session`, queues it, and opens the extension download-manager
page.

The manager processes one item at a time. Direct media responses are piped to a
`FileSystemWritableFileStream`. HLS master playlists are read by Mediabunny,
which selects primary video and audio tracks and remuxes them to MP4 while
streaming the result to the same writable file. MP4 fast-start rewriting is
disabled to avoid buffering the complete output in memory.

Relative HLS child URLs do not inherit a signed master URL's query string. The
manager copies only the CloudFront `Policy`, `Signature`, `Key-Pair-Id`, and
`Expires` values to child playlists and segments beneath the same CDN origin and
media directory. These values remain session-only and are redacted from logs.

Some Fansly MPEG-TS variant segments contain their own multiplexed AAC track even
when the master manifest also declares separate audio renditions. This is why
Chrome can play audio while its network panel shows only `.m3u8` and `.ts`
requests. The manager first tries that embedded audio, matching Chrome. It then
tries the declared default audio, the first alternate audio, and finally a
video-only MP4. Diagnostics identify every attempt and the completed status
explicitly warns when the resulting file has no audio.

The selected `FileSystemDirectoryHandle` is stored in extension-origin
IndexedDB. Chrome may require the user to choose or authorize the folder again
after a browser restart. Persistent download history contains metadata and the
sanitized relative filename, but never signed source URLs.

## Diagnostics

Enable **Detailed browser diagnostics** in the in-page settings before starting
a download. The manager displays request status, safe response metadata,
conversion details, and sanitized HLS manifests. Query strings remain redacted.
Use **Copy logs** to copy the visible JSON-lines log for troubleshooting.

## Manual test

1. Build the Chrome extension and reload `.output/chrome-mv3` as an unpacked
   extension.
2. Open Fansly and select **Choose download folder** in the extension settings.
3. Keep the download-manager tab open, select one video, and start the download.
4. Verify that progress advances and that Pause, Resume, and Cancel work.
5. Verify the resulting MP4 in the selected folder and its completed history
   entry. Retrying a failed entry automatically rescans its originating chat to
   obtain fresh signed media URLs before placing it back in the download queue.

Download history stores the originating chat ID and account-media ID for this
rediscovery, but it never stores a signed source URL. Legacy failed entries that
predate these fields are located by scanning the cached chat list.
