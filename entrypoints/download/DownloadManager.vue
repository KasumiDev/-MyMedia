<script setup lang="ts">
import {
  Conversion,
  HLS_FORMATS,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource
} from "mediabunny";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  BROWSER_DOWNLOAD_PROCESSOR_KEY,
  BROWSER_DOWNLOAD_QUEUE_PREFIX,
  BROWSER_DOWNLOAD_REVISION_KEY,
  browserDownloadJobKey,
  browserDownloadQueueKey,
  type BrowserDownloadJob
} from "../../src/core/browser-download";
import { sanitizeFilenameComponent } from "../../src/core/filenames";
import {
  authorizeHlsRequestUrl,
  preferMuxedHlsAudio
} from "../../src/core/hls-request";
import {
  loadDownloadDirectoryHandle,
  saveDownloadDirectoryHandle
} from "../../src/storage/download-directory";
import { upsertDownloadRecord } from "../../src/storage/download-index";

const SETTINGS_KEY = "fansly-mymedia:settings";
const DOWNLOAD_REVISION_KEY = "fansly-mymedia:download-revision";
const MAX_MANIFEST_LOG_BYTES = 64 * 1024;
const MAX_ERROR_RESPONSE_LOG_BYTES = 8 * 1024;

type PermissionState = "granted" | "denied" | "prompt";
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
};

const folderName = ref<string | null>(null);
const status = ref("Waiting for download jobs…");
const progress = ref(0);
const activeJob = ref<BrowserDownloadJob | null>(null);
const paused = ref(false);
const running = ref(false);
const logs = ref<string[]>([]);
const queueLength = ref(0);
const settingsOnly = new URLSearchParams(window.location.search).get("settings") === "1";

let directoryHandle: FileSystemDirectoryHandle | null = null;
let conversion: Conversion | null = null;
let directController: AbortController | null = null;
let pauseController: AbortController | null = null;
let processPromise: Promise<void> | null = null;
let resumeResolver: (() => void) | null = null;
let disposed = false;
let heartbeatTimer: number | null = null;
let cancelRequested = false;

type HlsAudioMode = "muxed" | "primary" | "alternate" | "none";

class HlsAudioRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HlsAudioRequestError";
  }
}

class MissingAlternateAudioError extends Error {
  constructor() {
    super("The HLS manifest does not contain an alternate audio track.");
    this.name = "MissingAlternateAudioError";
  }
}

const debugEnabled = computed(() => activeJob.value?.debug === true);

onMounted(async () => {
  directoryHandle = await loadDownloadDirectoryHandle();
  folderName.value = directoryHandle?.name ?? null;
  if (settingsOnly) {
    status.value = "Choose the folder where files should be stored.";
    return;
  }
  await chrome.storage.session.set({
    [BROWSER_DOWNLOAD_PROCESSOR_KEY]: Date.now()
  });
  heartbeatTimer = window.setInterval(() => {
    void chrome.storage.session.set({
      [BROWSER_DOWNLOAD_PROCESSOR_KEY]: Date.now()
    });
  }, 5_000);
  chrome.storage.onChanged.addListener(handleStorageChange);
  await refreshQueueLength();
  void processQueue();
});

onBeforeUnmount(() => {
  disposed = true;
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  chrome.storage.onChanged.removeListener(handleStorageChange);
  if (!settingsOnly) {
    void chrome.storage.session.remove(BROWSER_DOWNLOAD_PROCESSOR_KEY);
  }
  void conversion?.cancel();
});

async function chooseFolder(): Promise<void> {
  const picker = window as unknown as Window & {
    showDirectoryPicker(options?: {
      id?: string;
      mode?: "read" | "readwrite";
      startIn?: "downloads";
    }): Promise<FileSystemDirectoryHandle>;
  };
  try {
    const handle = await picker.showDirectoryPicker({
      id: "fansly-mymedia-downloads",
      mode: "readwrite",
      startIn: "downloads"
    });
    await saveDownloadDirectoryHandle(handle);
    directoryHandle = handle;
    folderName.value = handle.name;
    await saveFolderName(handle.name);
    status.value = `Downloads will be saved directly in ${handle.name}.`;
    if (!settingsOnly) void processQueue();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      status.value = error instanceof Error
        ? error.message
        : "Chrome could not open the selected folder.";
    }
  }
}

async function processQueue(): Promise<void> {
  if (processPromise || disposed) return;
  processPromise = runQueue().finally(() => {
    processPromise = null;
  });
  await processPromise;
}

async function runQueue(): Promise<void> {
  while (!disposed) {
    const job = await takeNextJob();
    if (!job) {
      status.value = directoryHandle
        ? "Waiting for download jobs…"
        : "Choose a download folder to begin.";
      return;
    }
    if (!directoryHandle || !(await ensureDirectoryPermission(directoryHandle))) {
      await restoreJob(job);
      status.value = "Choose or authorize a download folder to continue.";
      return;
    }
    await runJob(job);
  }
}

async function runJob(job: BrowserDownloadJob): Promise<void> {
  const historyDirectory = sanitizeFilenameComponent(
    directoryHandle?.name ?? "Downloads",
    "Downloads"
  );
  job = {
    ...job,
    historyFilename: `${historyDirectory}/${job.outputFilename}`
  };
  await chrome.storage.session.set({
    [browserDownloadJobKey(job.mediaId)]: job
  });
  activeJob.value = job;
  progress.value = 0;
  running.value = true;
  cancelRequested = false;
  logs.value = [];
  status.value = `Downloading ${job.outputFilename}…`;
  debugLog("download.started", {
    kind: job.kind,
    outputFilename: job.outputFilename,
    userAgent: navigator.userAgent
  });
  await updateHistory(job, "downloading");
  let writable: FileSystemWritableFileStream | null = null;
  let completedAudioMode: HlsAudioMode | null = null;

  try {
    if (job.kind === "hls") {
      completedAudioMode = await downloadHls(job);
    } else {
      writable = await createOutputWritable(job.outputFilename);
      await downloadDirect(job, writable);
    }

    progress.value = 100;
    status.value = completedAudioMode === "none"
      ? `Completed ${job.outputFilename} without audio.`
      : completedAudioMode === "alternate"
        ? `Completed ${job.outputFilename} with alternate audio.`
        : completedAudioMode === "muxed"
          ? `Completed ${job.outputFilename} with embedded audio.`
          : `Completed ${job.outputFilename}`;
    debugLog("download.completed", {
      outputFilename: job.outputFilename,
      audioMode: completedAudioMode
    });
    await updateHistory(job, "completed");
    await chrome.storage.session.remove(browserDownloadJobKey(job.mediaId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browser download failed.";
    status.value = message;
    await writable?.abort().catch(() => undefined);
    await directoryHandle?.removeEntry(job.outputFilename).catch(() => undefined);
    await updateHistory(job, "failed", message);
    debugLog("download.failed", { message });
  } finally {
    conversion = null;
    directController = null;
    pauseController = null;
    resumeResolver = null;
    paused.value = false;
    running.value = false;
    activeJob.value = null;
  }
}

async function downloadHls(job: BrowserDownloadJob): Promise<HlsAudioMode> {
  const modes: HlsAudioMode[] = ["muxed", "primary", "alternate", "none"];

  for (const mode of modes) {
    let writable: FileSystemWritableFileStream | null = null;
    try {
      progress.value = 0;
      status.value = hlsAttemptStatus(job.outputFilename, mode);
      debugLog("hls.attempt.started", { audioMode: mode });
      writable = await createOutputWritable(job.outputFilename);
      await downloadHlsAttempt(job, writable, mode);
      debugLog("hls.attempt.completed", { audioMode: mode });
      return mode;
    } catch (error) {
      await conversion?.cancel().catch(() => undefined);
      await writable?.abort().catch(() => undefined);
      await directoryHandle?.removeEntry(job.outputFilename).catch(() => undefined);
      const canFallback = !cancelRequested && (
        mode === "muxed"
        || error instanceof HlsAudioRequestError
        || error instanceof MissingAlternateAudioError
      );
      debugLog("hls.attempt.failed", {
        audioMode: mode,
        fallback: canFallback && mode !== "none",
        message: error instanceof Error ? error.message : "HLS attempt failed."
      });
      conversion = null;
      pauseController = null;
      if (!canFallback || mode === "none") throw error;
    }
  }

  throw new Error("No HLS download attempt was available.");
}

async function downloadHlsAttempt(
  job: BrowserDownloadJob,
  writable: FileSystemWritableFileStream,
  audioMode: HlsAudioMode
): Promise<void> {
  const failedAudioRequest: {
    value: { status: number; url: string } | null;
  } = { value: null };
  const fetchFn: typeof fetch = async (input, init) => {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const authorized = authorizeHlsRequestUrl(job.sourceUrl, requestUrl);
    const authorizedInput = input instanceof Request
      ? new Request(authorized.url, input)
      : authorized.url;
    debugLog("request.started", {
      url: redactUrl(requestUrl),
      cloudFrontCredentialsAttached: authorized.credentialsAttached
    });
    let response = await fetch(authorizedInput, {
      ...init,
      credentials: "include"
    });
    if (audioMode === "muxed" && response.ok
      && isMasterManifestRequest(job.sourceUrl, requestUrl)) {
      const manifest = await response.text();
      const muxedManifest = preferMuxedHlsAudio(manifest);
      if (muxedManifest !== manifest) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-range");
        response = new Response(muxedManifest, {
          status: 200,
          headers
        });
        debugLog("manifest.prefer-muxed-audio", {
          url: redactUrl(requestUrl)
        });
      }
    }
    debugLog("request.completed", {
      url: redactUrl(response.url || requestUrl),
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
      contentRange: response.headers.get("content-range")
    });
    const responsePath = new URL(response.url || requestUrl).pathname;
    if (!response.ok && responsePath.includes("/audio/")) {
      failedAudioRequest.value = {
        status: response.status,
        url: redactUrl(response.url || requestUrl)
      };
    }
    if (job.debug && /\.m3u8(?:$|\?)/iu.test(requestUrl)) {
      try {
        const body = await response.clone().text();
        debugLog("manifest.body", {
          url: redactUrl(requestUrl),
          body: redactManifest(body.slice(0, MAX_MANIFEST_LOG_BYTES)),
          truncated: body.length > MAX_MANIFEST_LOG_BYTES
        });
      } catch (error) {
        debugLog("manifest.capture-failed", {
          message: error instanceof Error ? error.message : "Manifest capture failed."
        });
      }
    }
    if (job.debug && !response.ok) {
      try {
        const body = await response.clone().text();
        debugLog("error-response.body", {
          url: redactUrl(requestUrl),
          body: redactResponseBody(body.slice(0, MAX_ERROR_RESPONSE_LOG_BYTES)),
          truncated: body.length > MAX_ERROR_RESPONSE_LOG_BYTES
        });
      } catch (error) {
        debugLog("error-response.capture-failed", {
          message: error instanceof Error
            ? error.message
            : "Error response capture failed."
        });
      }
    }
    return response;
  };
  const input = new Input({
    formats: HLS_FORMATS,
    source: new UrlSource(job.sourceUrl, {
      fetchFn,
      maxCacheSize: 64 * 1024 * 1024,
      parallelism: 2,
      requestInit: { credentials: "include" }
    })
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, {
      chunked: true,
      chunkSize: 4 * 1024 * 1024
    })
  });
  try {
    const primaryVideoTrack = await input.getPrimaryVideoTrack();
    if (!primaryVideoTrack) throw new Error("The HLS manifest has no video track.");
    const audioTracks = await input.getAudioTracks();
    const primaryAudioTrack = await input.getPrimaryAudioTrack();
    const selectedAudioTrack = audioMode === "none"
      ? null
      : audioMode === "primary" || audioMode === "muxed"
        ? primaryAudioTrack
        : audioTracks.find((track) => track !== primaryAudioTrack) ?? null;
    if (audioMode === "alternate" && !selectedAudioTrack) {
      throw new MissingAlternateAudioError();
    }
    debugLog("hls.tracks.selected", {
      audioMode,
      availableAudioTracks: await Promise.all(audioTracks.map(async (track) => ({
        number: track.number,
        language: await track.getLanguageCode(),
        name: await track.getName()
      }))),
      selectedAudioTrack: selectedAudioTrack
        ? {
            number: selectedAudioTrack.number,
            language: await selectedAudioTrack.getLanguageCode(),
            name: await selectedAudioTrack.getName()
          }
        : null
    });
    conversion = await Conversion.init({
      input,
      output,
      tracks: "all",
      video: (track) => ({ discard: track !== primaryVideoTrack }),
      audio: (track) => ({ discard: track !== selectedAudioTrack }),
      showWarnings: job.debug
    });
    if (!conversion.isValid) {
      throw new Error("The HLS video and audio tracks cannot be written to MP4.");
    }
    conversion.onProgress = (value) => {
      progress.value = Math.max(0, Math.min(100, Math.round(value * 100)));
    };
    debugLog("conversion.started", {
      utilizedTracks: conversion.utilizedTracks.length,
      discardedTracks: conversion.discardedTracks.length
    });

    await executeConversion();
    if (cancelRequested || conversion.state === "canceled") {
      throw new DOMException("Download cancelled.", "AbortError");
    }
  } catch (error) {
    if (failedAudioRequest.value) {
      throw new HlsAudioRequestError(
        `Audio request failed with HTTP ${failedAudioRequest.value.status}: ${failedAudioRequest.value.url}`
      );
    }
    throw error;
  } finally {
    input.dispose();
  }
}

async function createOutputWritable(
  outputFilename: string
): Promise<FileSystemWritableFileStream> {
  const fileHandle = await directoryHandle?.getFileHandle(outputFilename, {
    create: true
  });
  if (!fileHandle) throw new Error("The download folder is unavailable.");
  return fileHandle.createWritable();
}

function hlsAttemptStatus(outputFilename: string, mode: HlsAudioMode): string {
  if (mode === "muxed") return `Trying embedded audio for ${outputFilename}…`;
  if (mode === "primary") return `Downloading ${outputFilename}…`;
  if (mode === "alternate") {
    return `Primary audio failed. Trying alternate audio for ${outputFilename}…`;
  }
  return `Audio tracks failed. Trying video-only for ${outputFilename}…`;
}

function isMasterManifestRequest(sourceUrl: string, requestUrl: string): boolean {
  const source = new URL(sourceUrl);
  const request = new URL(requestUrl);
  return source.origin === request.origin && source.pathname === request.pathname;
}

async function executeConversion(): Promise<void> {
  while (conversion && conversion.state !== "done" && conversion.state !== "canceled") {
    if (paused.value) {
      await new Promise<void>((resolve) => {
        resumeResolver = resolve;
      });
    }
    pauseController = new AbortController();
    await conversion.execute({ pauseSignal: pauseController.signal });
  }
}

async function downloadDirect(
  job: BrowserDownloadJob,
  writable: FileSystemWritableFileStream
): Promise<void> {
  directController = new AbortController();
  const response = await fetch(job.sourceUrl, {
    credentials: "include",
    signal: directController.signal
  });
  debugLog("direct.response", {
    url: redactUrl(response.url),
    status: response.status,
    contentLength: response.headers.get("content-length"),
    contentType: response.headers.get("content-type")
  });
  if (!response.ok || !response.body) {
    await writable.abort();
    throw new Error(`Media request failed with HTTP ${response.status}.`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const progressStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (total > 0) progress.value = Math.round((received / total) * 100);
      controller.enqueue(chunk);
    }
  });
  await response.body.pipeThrough(progressStream).pipeTo(writable, {
    signal: directController.signal
  });
}

function pauseDownload(): void {
  if (!conversion || paused.value) return;
  paused.value = true;
  pauseController?.abort();
  status.value = "Download paused.";
  debugLog("download.paused", {});
}

function resumeDownload(): void {
  if (!paused.value) return;
  paused.value = false;
  status.value = activeJob.value
    ? `Downloading ${activeJob.value.outputFilename}…`
    : "Resuming…";
  resumeResolver?.();
  resumeResolver = null;
  debugLog("download.resumed", {});
}

async function cancelDownload(): Promise<void> {
  cancelRequested = true;
  debugLog("download.cancelled", {});
  directController?.abort();
  await conversion?.cancel();
  resumeResolver?.();
  resumeResolver = null;
}

async function copyLogs(): Promise<void> {
  try {
    await navigator.clipboard.writeText(logs.value.join("\n"));
    status.value = "Diagnostics copied to the clipboard.";
  } catch {
    status.value = "Chrome could not copy the diagnostics.";
  }
}

async function takeNextJob(): Promise<BrowserDownloadJob | null> {
  const stored = await chrome.storage.session.get(null);
  const queued = queuedMedia(stored);
  const mediaId = queued[0]?.mediaId;
  if (!mediaId) {
    queueLength.value = 0;
    return null;
  }
  await chrome.storage.session.remove(browserDownloadQueueKey(mediaId));
  queueLength.value = Math.max(0, queued.length - 1);
  const key = browserDownloadJobKey(mediaId);
  return parseJob(stored[key]);
}

async function restoreJob(job: BrowserDownloadJob): Promise<void> {
  await chrome.storage.session.set({
    [browserDownloadQueueKey(job.mediaId)]: Date.now()
  });
  await refreshQueueLength();
}

async function refreshQueueLength(): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  queueLength.value = queuedMedia(stored).length;
}

function handleStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
): void {
  if (areaName === "local" && changes[BROWSER_DOWNLOAD_REVISION_KEY]) {
    void refreshQueueLength().then(processQueue);
  }
  if (areaName === "local" && changes[SETTINGS_KEY]) {
    void loadDownloadDirectoryHandle().then((handle) => {
      directoryHandle = handle;
      folderName.value = handle?.name ?? null;
      return processQueue();
    });
  }
}

async function ensureDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permissionHandle = handle as PermissionHandle;
  const options = { mode: "readwrite" as const };
  if (await permissionHandle.queryPermission(options) === "granted") return true;
  return false;
}

async function saveFolderName(name: string): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY];
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...(settings && typeof settings === "object" ? settings : {}),
      downloadDirectory: sanitizeFilenameComponent(name, "Downloads")
    }
  });
}

async function updateHistory(
  job: BrowserDownloadJob,
  state: "downloading" | "completed" | "failed",
  error?: string
): Promise<void> {
  await upsertDownloadRecord({
    mediaId: job.mediaId,
    accountMediaId: job.accountMediaId,
    sourceGroupId: job.sourceGroupId,
    filename: job.historyFilename,
    originalFilename: job.originalFilename,
    createdAt: job.createdAt,
    likeCount: job.likeCount,
    price: job.price,
    state,
    ...(error ? { error: error.slice(0, 500) } : {}),
    updatedAt: Date.now()
  });
  await chrome.storage.local.set({
    [DOWNLOAD_REVISION_KEY]: `${Date.now()}-${crypto.randomUUID()}`
  });
}

function queuedMedia(
  stored: Record<string, unknown>
): Array<{ mediaId: string; queuedAt: number }> {
  return Object.entries(stored)
    .flatMap(([key, value]) => {
      if (!key.startsWith(BROWSER_DOWNLOAD_QUEUE_PREFIX)
        || typeof value !== "number") return [];
      const mediaId = key.slice(BROWSER_DOWNLOAD_QUEUE_PREFIX.length);
      return /^[A-Za-z0-9_-]{1,128}$/u.test(mediaId)
        ? [{ mediaId, queuedAt: value }]
        : [];
    })
    .sort((left, right) =>
      left.queuedAt - right.queuedAt || left.mediaId.localeCompare(right.mediaId)
    );
}

function parseJob(value: unknown): BrowserDownloadJob | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Partial<BrowserDownloadJob>;
  return (job.kind === "direct" || job.kind === "hls")
    && typeof job.mediaId === "string"
    && typeof job.accountMediaId === "string"
    && typeof job.sourceGroupId === "string"
    && typeof job.sourceUrl === "string"
    && typeof job.outputFilename === "string"
    && typeof job.historyFilename === "string"
    && typeof job.originalFilename === "string"
    && typeof job.createdAt === "number"
    && typeof job.likeCount === "number"
    && typeof job.price === "number"
    && typeof job.debug === "boolean"
    ? job as BrowserDownloadJob
    : null;
}

function debugLog(event: string, details: Record<string, unknown>): void {
  if (!debugEnabled.value) return;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    mediaId: activeJob.value?.mediaId,
    ...details
  });
  logs.value = [...logs.value.slice(-199), entry];
  console.debug("[Fansly MyMedia]", entry);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
  } catch {
    return "[invalid URL]";
  }
}

function redactManifest(value: string): string {
  return value.replace(/https:\/\/[^\s"']+/gu, (url) => redactUrl(url));
}

function redactResponseBody(value: string): string {
  return redactManifest(value)
    .replace(/(Policy|Signature|Key-Pair-Id|Expires)=([^&\s<]+)/giu, "$1=[redacted]");
}
</script>

<template>
  <main class="mx-auto grid min-h-screen max-w-4xl content-start gap-6 p-8">
    <header>
      <p class="text-xs font-semibold tracking-widest text-violet-300 uppercase">
        Fansly MyMedia
      </p>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight">
        Browser download manager
      </h1>
      <p class="mt-2 text-sm text-zinc-400">
        Full-quality HLS videos are combined and written directly by Chrome.
      </p>
    </header>

    <section class="rounded-2xl border border-white/10 bg-zinc-900 p-5">
      <div class="flex items-center gap-4">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">
            Download folder
          </p>
          <p class="mt-1 truncate text-xs text-zinc-400">
            {{ folderName ?? "No folder selected" }}
          </p>
        </div>
        <button
          class="
            rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium
            hover:bg-violet-500
          "
          type="button"
          @click="chooseFolder"
        >
          Choose folder
        </button>
      </div>
    </section>

    <section class="rounded-2xl border border-white/10 bg-zinc-900 p-5">
      <div class="flex items-center justify-between gap-4 text-sm">
        <span>{{ status }}</span>
        <span class="text-zinc-400">{{ queueLength }} queued</span>
      </div>
      <div class="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          class="h-full rounded-full bg-violet-500 transition-all"
          :style="{ width: `${progress}%` }"
        />
      </div>
      <div class="mt-4 flex gap-3">
        <button
          class="
            rounded-lg bg-zinc-800 px-4 py-2 text-sm
            hover:bg-zinc-700
            disabled:opacity-40
          "
          type="button"
          :disabled="!running || paused || !conversion"
          @click="pauseDownload"
        >
          Pause
        </button>
        <button
          class="
            rounded-lg bg-zinc-800 px-4 py-2 text-sm
            hover:bg-zinc-700
            disabled:opacity-40
          "
          type="button"
          :disabled="!paused"
          @click="resumeDownload"
        >
          Resume
        </button>
        <button
          class="
            rounded-lg bg-red-950 px-4 py-2 text-sm text-red-200
            hover:bg-red-900
            disabled:opacity-40
          "
          type="button"
          :disabled="!running"
          @click="cancelDownload"
        >
          Cancel
        </button>
      </div>
    </section>

    <section
      v-if="debugEnabled || logs.length"
      class="rounded-2xl border border-white/10 bg-black p-5"
    >
      <div class="flex items-center justify-between gap-4">
        <h2 class="text-sm font-medium">
          Detailed diagnostics
        </h2>
        <button
          class="
            rounded-lg bg-zinc-800 px-3 py-1.5 text-xs
            hover:bg-zinc-700
          "
          type="button"
          @click="copyLogs"
        >
          Copy logs
        </button>
      </div>
      <pre
        class="
          mt-3 max-h-96 overflow-auto text-xs whitespace-pre-wrap text-zinc-400
        "
      >{{ logs.join("\n") }}</pre>
    </section>
  </main>
</template>
