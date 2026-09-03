# Fansly MyMedia

A Chrome extension for collecting and downloading media from the signed-in
user's Fansly MyMedia library. It discovers chats, lists images and videos in a
separate library page, and downloads selected media directly to a folder chosen
by the user.

## Download

[Download the latest Chrome extension](../../releases/latest/download/fansly-mymedia-chrome.zip)

The download is a ZIP archive for manual installation:

1. Extract `fansly-mymedia-chrome.zip` to a permanent folder.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted folder.
5. Open and sign in to Fansly, then select the extension from Chrome's toolbar.

Chrome may remove or disable an unpacked extension if its extracted folder is
moved. Keep the folder in place when updating or using the extension.

## Features

- Discovers media from the user's chats with configurable collection limits.
- Lists images, videos, completed downloads, and failed downloads separately.
- Selects the highest available HLS video quality and streams it to MP4.
- Shows batch and per-file progress without buffering the complete video in RAM.
- Stores download history and small thumbnails locally in the browser.
- Supports pausing collection and downloads, plus retrying failed downloads.

## Development

Requirements: Node.js 22 or newer and npm.

```shell
npm ci
npm run build
```

The unpacked Chrome extension is generated in `.output/chrome-mv3`.

Before submitting changes, run:

```shell
npm run lint
npm run typecheck
npm test
```

## Creating a release

The extension manifest reads its version from `package.json`. Use npm to update
both `package.json` and `package-lock.json` and create the matching commit and
Git tag:

```shell
npm version patch
git push --follow-tags
```

Use `npm version minor` or `npm version major` when appropriate. The release
workflow verifies that the pushed tag exactly matches the package version, such
as tag `v0.1.1` for package version `0.1.1`.

GitHub Actions verifies the project, packages the Chrome build, creates a GitHub
release with generated notes, and attaches it as
`fansly-mymedia-chrome.zip`. The stable download link above always resolves to
that asset from the newest release.

Only download media you are authorized to access and retain.
