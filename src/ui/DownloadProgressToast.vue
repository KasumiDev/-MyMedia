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
  BROWSER_DOWNLOAD_QUEUE_PREFIX,
  BROWSER_DOWNLOAD_REVISION_KEY,
  browserDownloadJobKey,
  browserDownloadQueueKey,
  type BrowserDownloadJob
} from "../core/browser-download";
import { sanitizeFilenameComponent } from "../core/filenames";
import {
  authorizeHlsRequestUrl,
  preferMuxedHlsAudio
} from "../core/hls-request";
import { loadDownloadDirectoryHandle } from "../storage/download-directory";
import { upsertDownloadRecord } from "../storage/download-index";

const SETTINGS_KEY = "fansly-mymedia:settings";
const DOWNLOAD_REVISION_KEY = "fansly-mymedia:download-revision";
const MAX_MANIFEST_LOG_BYTES = 64 * 1024;
const MAX_ERROR_RESPONSE_LOG_BYTES = 8 * 1024;

type PermissionState = "granted" | "denied" | "prompt";
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
};

const emit = defineEmits<{
  folderRequired: [];
}>();

const status = ref("Waiting for download jobs…");
const progress = ref(0);
const activeJob = ref<BrowserDownloadJob | null>(null);
const paused = ref(false);
const running = ref(false);
const logs = ref<string[]>([]);
const queueLength = ref(0);
const toastVisible = ref(false);
const batchTotal = ref(0);
const batchProcessed = ref(0);
const batchFailed = ref(0);
const lastFilename = ref<string | null>(null);

let directoryHandle: FileSystemDirectoryHandle | null = null;
let conversion: Conversion | null = null;
let directController: AbortController | null = null;
let pauseController: AbortController | null = null;
let processPromise: Promise<void> | null = null;
let resumeResolver: (() => void) | null = null;
let disposed = false;
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
const batchProgress = computed(() => batchTotal.value > 0
  ? Math.round((batchProcessed.value / batchTotal.value) * 100)
  : 0);

onMounted(async () => {
  directoryHandle = await loadDownloadDirectoryHandle();
  chrome.storage.onChanged.addListener(handleStorageChange);
  await refreshQueueLength();
  registerQueueState();
  void processQueue();
});

onBeforeUnmount(() => {
  disposed = true;
  chrome.storage.onChanged.removeListener(handleStorageChange);
  void conversion?.cancel();
});

async function processQueue(): Promise<void> {
  if (processPromise || disposed) return;
  processPromise = runQueue().finally(() => {
    processPromise = null;
    if (!disposed) {
      void refreshQueueLength().then(() => {
        if (queueLength.value > 0) {
          registerQueueState();
          void processQueue();
        }
      });
    }
  });
  await processPromise;
}

async function runQueue(): Promise<void> {
  while (!disposed) {
    const job = await takeNextJob();
    if (!job) {
      if (batchTotal.value > 0 && batchProcessed.value >= batchTotal.value) {
        status.value = batchFailed.value > 0
          ? `Batch finished with ${batchFailed.value} failed file${batchFailed.value === 1 ? "" : "s"}.`
          : "Batch complete.";
      } else {
        status.value = directoryHandle
          ? "Waiting for download jobs…"
          : "Choose a download folder to begin.";
      }
      return;
    }
    if (!directoryHandle || !(await ensureDirectoryPermission(directoryHandle))) {
      await restoreJob(job);
      status.value = "Download folder access is required to continue.";
      emit("folderRequired");
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
  lastFilename.value = job.outputFilename;
  toastVisible.value = true;
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
    batchFailed.value += 1;
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
    batchProcessed.value += 1;
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

function registerQueueState(): void {
  if (queueLength.value === 0) return;

  const previousBatchComplete = !running.value
    && batchTotal.value > 0
    && batchProcessed.value >= batchTotal.value;

  if (!toastVisible.value || previousBatchComplete) {
    batchTotal.value = 0;
    batchProcessed.value = 0;
    batchFailed.value = 0;
    progress.value = 0;
    logs.value = [];
  }

  toastVisible.value = true;
  batchTotal.value = Math.max(
    batchTotal.value,
    batchProcessed.value + queueLength.value + (running.value ? 1 : 0)
  );
}

function handleStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
): void {
  if (areaName === "local" && changes[BROWSER_DOWNLOAD_REVISION_KEY]) {
    void refreshQueueLength().then(() => {
      registerQueueState();
      return processQueue();
    });
  }
  if (areaName === "local" && changes[SETTINGS_KEY]) {
    void loadDownloadDirectoryHandle().then((handle) => {
      directoryHandle = handle;
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
  <aside
    v-if="toastVisible"
    aria-label="Download progress"
    aria-live="polite"
    class="
      fixed right-5 bottom-28 z-50 w-[min(28rem,calc(100vw-2.5rem))]
      overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95
      text-zinc-100 shadow-2xl shadow-black/60 backdrop-blur-sm
    "
  >
    <header class="flex items-start gap-3 border-b border-white/10 px-4 py-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-semibold">
          Downloads
        </h2>
        <p class="mt-0.5 text-xs text-zinc-400">
          {{ batchProcessed }} of {{ batchTotal }} files processed
          <template v-if="batchFailed">
            · {{ batchFailed }} failed
          </template>
        </p>
      </div>
      <button
        aria-label="Close download progress"
        class="
          rounded-md px-2 py-1 text-sm text-zinc-400 transition
          hover:bg-white/10 hover:text-white
          disabled:cursor-not-allowed disabled:opacity-40
        "
        type="button"
        :disabled="running || queueLength > 0"
        title="Downloads must finish before this notification can be closed"
        @click="toastVisible = false"
      >
        ✕
      </button>
    </header>

    <div class="grid gap-4 p-4">
      <section>
        <div class="flex justify-between text-xs text-zinc-400">
          <span>Batch progress</span>
          <span>{{ batchProgress }}%</span>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
          <div
            class="
              h-full rounded-full bg-violet-500 transition-all duration-300
            "
            :style="{ width: `${batchProgress}%` }"
          />
        </div>
      </section>

      <section>
        <div
          class="flex items-center justify-between gap-3 text-xs text-zinc-400"
        >
          <span class="min-w-0 truncate">
            {{ activeJob?.outputFilename ?? lastFilename ?? "Preparing download…" }}
          </span>
          <span class="shrink-0">{{ progress }}%</span>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
          <div
            class="h-full rounded-full bg-cyan-400 transition-all duration-300"
            :style="{ width: `${progress}%` }"
          />
        </div>
      </section>

      <div class="flex items-start justify-between gap-4">
        <p class="min-w-0 text-xs/5 text-zinc-300">
          {{ status }}
        </p>
        <p class="shrink-0 text-xs/5 text-zinc-500">
          {{ queueLength }} queued
        </p>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          class="
            rounded-lg bg-zinc-800 px-3 py-2 text-xs transition
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
            rounded-lg bg-zinc-800 px-3 py-2 text-xs transition
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
            rounded-lg bg-red-950 px-3 py-2 text-xs text-red-200 transition
            hover:bg-red-900
            disabled:opacity-40
          "
          type="button"
          :disabled="!running"
          @click="cancelDownload"
        >
          Cancel file
        </button>
      </div>

      <details
        v-if="debugEnabled || logs.length"
        class="border-t border-white/10 pt-3"
      >
        <summary class="cursor-pointer text-xs font-medium text-zinc-300">
          Detailed diagnostics
        </summary>
        <div class="mt-3 flex justify-end">
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
            mt-2 max-h-48 overflow-auto rounded-lg bg-black p-3 text-xs
            whitespace-pre-wrap text-zinc-400
          "
        >{{ logs.join("\n") }}</pre>
      </details>
    </div>
  </aside>
</template>
