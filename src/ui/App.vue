<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import {
  buildDownloadFilename,
  DEFAULT_DOWNLOAD_DIRECTORY,
  normalizeDownloadDirectory,
  formatMediaCreatedAt
} from "../core/filenames";
import { mergeUniqueMedia } from "../core/media-library";
import {
  isMediaSortOrder,
  sortMedia,
  type MediaSortOrder
} from "../core/media-sort";
import { paginateGroups, paginateMedia } from "../core/pagination";
import type {
  DownloadIndex,
  DownloadRecord,
  DownloadState
} from "../storage/download-index";
import DownloadThumbnail from "./DownloadThumbnail.vue";
import VideoStripePreview from "./VideoStripePreview.vue";

const DOWNLOAD_REVISION_KEY = "fansly-mymedia:download-revision";
const SETTINGS_KEY = "fansly-mymedia:settings";
const DEFAULT_CHAT_LIMIT = 10;

type Group = {
  groupId: string;
  partnerUsername: string;
};

type MediaKind = "image" | "video";
type LibraryTab = MediaKind | "downloaded" | "failed";

type DiscoveredMedia = {
  accountMediaId: string;
  mediaId: string;
  kind: MediaKind;
  url: string;
  previewUrl: string | null;
  width: number;
  height: number;
  createdAt: number;
  originalFilename: string;
  likeCount: number;
  price: number;
  stripeUrl: string | null;
  stripeFrameWidth: number;
  stripeFrameHeight: number;
  extension: string;
  manifestUrl: string | null;
};

type MediaItem = DiscoveredMedia & {
  state: DownloadState | "ready";
};

type BridgeResult = {
  ok: boolean;
  mode?: "browser" | "companion";
  payload?: unknown;
  error?: string;
};

type CompanionStatus = {
  available: boolean;
  checking: boolean;
  version?: string;
  error?: string;
  active?: {
    mediaId: string;
    percent?: number;
    totalSize?: number;
    speed?: number;
  };
};

const isOpen = ref(false);
const isSettingsOpen = ref(false);
const isCollecting = ref(false);
const isCollectionPaused = ref(false);
const isDownloading = ref(false);
const activeTab = ref<LibraryTab>("image");
const groups = ref<Group[]>([]);
const library = ref<MediaItem[]>([]);
const selectedIds = ref(new Set<string>());
const downloadIndex = ref<DownloadIndex>({});
const status = ref("Open MyMedia to begin collecting your library.");
const currentChat = ref(0);
const chatLimit = ref(DEFAULT_CHAT_LIMIT);
const minDelay = ref(1);
const maxDelay = ref(5);
const companionDebug = ref(false);
const downloadDirectory = ref(DEFAULT_DOWNLOAD_DIRECTORY);
const sortOrder = ref<MediaSortOrder>("created-desc");
const hoveredMediaId = ref<string | null>(null);
const focusedMediaId = ref<string | null>(null);
const companionStatus = ref<CompanionStatus>({
  available: false,
  checking: true
});

let collectionController: AbortController | null = null;
let pauseDownloadBatch = false;
let companionStatusTimer: number | null = null;

const imageCount = computed(() => countMedia("image"));
const videoCount = computed(() => countMedia("video"));
const downloadedRecords = computed(() => sortMedia(
  Object.values(downloadIndex.value).filter((record) => record.state === "completed"),
  sortOrder.value
));
const downloadedCount = computed(() => downloadedRecords.value.length);
const failedRecords = computed(() => sortMedia(
  Object.values(downloadIndex.value).filter((record) => record.state === "failed"),
  sortOrder.value
));
const failedCount = computed(() => failedRecords.value.length);
const collectionProgress = computed(() => groups.value.length === 0
  ? 0
  : Math.round((currentChat.value / groups.value.length) * 100));

const visibleMedia = computed(() => {
  if (activeTab.value === "downloaded" || activeTab.value === "failed") return [];
  return sortMedia(
    library.value.filter((item) =>
      item.kind === activeTab.value && item.state !== "completed" && item.state !== "failed"),
    sortOrder.value
  );
});

const selectedMedia = computed(() => library.value.filter((item) =>
  selectedIds.value.has(item.mediaId) && item.state === "ready"));

onMounted(async () => {
  chrome.storage.onChanged.addListener(handleStorageChange);
  await Promise.all([
    refreshDownloadIndex(),
    loadSettings(),
    refreshCompanionStatus(false)
  ]);
  companionStatusTimer = window.setInterval(() => {
    if (isOpen.value && (isDownloading.value || isSettingsOpen.value)) {
      void refreshCompanionStatus(false);
    }
  }, 1_000);
});

onBeforeUnmount(() => {
  collectionController?.abort();
  if (companionStatusTimer !== null) {
    window.clearInterval(companionStatusTimer);
  }
  chrome.storage.onChanged.removeListener(handleStorageChange);
});

async function openLibrary(): Promise<void> {
  isOpen.value = true;
  if (!isCollecting.value && library.value.length === 0) await collectLibrary();
}

async function collectLibrary(): Promise<void> {
  collectionController?.abort();
  collectionController = new AbortController();
  isCollecting.value = true;
  isCollectionPaused.value = false;
  currentChat.value = 0;
  status.value = "Discovering chats…";

  try {
    groups.value = await paginateGroups(fetchGroups, {
      pageSize: 30,
      limit: chatLimit.value,
      signal: collectionController.signal
    });
    await chrome.storage.local.set({ "fansly-mymedia:chats": groups.value });

    for (const [index, group] of groups.value.entries()) {
      if (collectionController.signal.aborted) break;
      currentChat.value = index + 1;
      status.value = `Collecting ${group.partnerUsername || group.groupId}…`;
      await paginateMedia(
        (before) => fetchMedia(group.groupId, before),
        {
          signal: collectionController.signal,
          onPage: (page) => addMedia(
            page.downloadableMedia as DiscoveredMedia[] | undefined
          )
        }
      );
    }

    status.value = collectionController.signal.aborted
      ? "Collection paused."
      : `Collection complete: ${library.value.length} media found.`;
  } catch (error) {
    status.value = collectionController.signal.aborted
      ? "Collection paused."
      : errorMessage(error, "Collection failed.");
  } finally {
    isCollecting.value = false;
  }
}

function pauseCollection(): void {
  collectionController?.abort();
  isCollectionPaused.value = true;
}

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY] as {
    chatLimit?: unknown;
    minDelay?: unknown;
    maxDelay?: unknown;
    sortOrder?: unknown;
    companionDebug?: unknown;
    downloadDirectory?: unknown;
  } | undefined;
  chatLimit.value = validInteger(settings?.chatLimit, 1, 100_000, DEFAULT_CHAT_LIMIT);
  minDelay.value = validInteger(settings?.minDelay, 1, 300, 1);
  maxDelay.value = validInteger(settings?.maxDelay, minDelay.value, 300, 5);
  companionDebug.value = settings?.companionDebug === true;
  downloadDirectory.value = normalizeDownloadDirectory(settings?.downloadDirectory);
  sortOrder.value = isMediaSortOrder(settings?.sortOrder)
    ? settings.sortOrder
    : "created-desc";
}

async function saveSettings(): Promise<void> {
  chatLimit.value = validInteger(chatLimit.value, 1, 100_000, DEFAULT_CHAT_LIMIT);
  minDelay.value = validInteger(minDelay.value, 1, 300, 1);
  maxDelay.value = validInteger(maxDelay.value, minDelay.value, 300, 5);
  downloadDirectory.value = normalizeDownloadDirectory(downloadDirectory.value);
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      chatLimit: chatLimit.value,
      minDelay: minDelay.value,
      maxDelay: maxDelay.value,
      sortOrder: sortOrder.value,
      companionDebug: companionDebug.value,
      downloadDirectory: downloadDirectory.value
    }
  });
  status.value = `Settings saved. The next collection will process up to ${chatLimit.value} chats.`;
}

function validInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function addMedia(items: DiscoveredMedia[] | undefined): void {
  if (!items) return;
  const additions: MediaItem[] = items.map((item) => ({
    ...item,
    state: downloadIndex.value[item.mediaId]?.state ?? "ready"
  }));
  library.value = mergeUniqueMedia(library.value, additions);
}

function toggleSelection(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleCardFromKeyboard(item: MediaItem): void {
  if (item.state === "ready") toggleSelection(item.mediaId);
}

function selectVisible(): void {
  const next = new Set(selectedIds.value);
  for (const item of visibleMedia.value) {
    if (item.state === "ready") next.add(item.mediaId);
  }
  selectedIds.value = next;
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

async function downloadSelected(): Promise<void> {
  isDownloading.value = true;
  pauseDownloadBatch = false;

  for (const item of selectedMedia.value) {
    if (pauseDownloadBatch) break;
    updateItemState(item.mediaId, "queued");
    const result = await chrome.runtime.sendMessage({
      type: "fansly-mymedia:download",
      url: item.url,
      previewUrl: item.previewUrl ?? (item.kind === "image" ? item.url : null),
      manifestUrl: item.kind === "video" ? item.manifestUrl : null,
      filename: buildDownloadFilename({
        mediaId: item.mediaId,
        createdAt: item.createdAt,
        extension: item.extension,
        downloadDirectory: downloadDirectory.value
      }),
      downloadDirectory: downloadDirectory.value,
      mediaId: item.mediaId,
      originalFilename: item.originalFilename,
      createdAt: item.createdAt,
      likeCount: item.likeCount,
      price: item.price,
      debug: companionDebug.value,
      userAgent: navigator.userAgent
    }) as BridgeResult;
    updateItemState(
      item.mediaId,
      result.ok
        ? result.mode === "companion" ? "completed" : "downloading"
        : "failed"
    );
  }

  isDownloading.value = false;
  status.value = pauseDownloadBatch
    ? "Download batch paused. Downloads already started continue in Chrome."
    : "Selected downloads submitted. Completed files move to Downloaded automatically.";
}

async function retryFailed(mediaId: string): Promise<void> {
  updateItemState(mediaId, "queued");
  const response = await chrome.runtime.sendMessage({
    type: "fansly-mymedia:retry-download",
    mediaId
  }) as BridgeResult;
  status.value = response.ok
    ? "Retry started."
    : response.error ?? "The download could not be retried.";
  await refreshDownloadIndex();
}

async function retryAllFailed(): Promise<void> {
  isDownloading.value = true;
  status.value = `Retrying ${failedCount.value} failed downloads…`;
  const response = await chrome.runtime.sendMessage({
    type: "fansly-mymedia:retry-all-failed"
  }) as { ok?: boolean; retried?: number; failed?: number };
  isDownloading.value = false;
  await refreshDownloadIndex();
  status.value = response.ok
    ? `${response.retried ?? 0} retries completed or started; ${response.failed ?? 0} unavailable.`
    : "Failed downloads could not be retried.";
}

async function refreshCompanionStatus(refresh: boolean): Promise<void> {
  if (refresh) {
    companionStatus.value = {
      ...companionStatus.value,
      checking: true
    };
  }

  const response = await chrome.runtime.sendMessage({
    type: "fansly-mymedia:get-companion-status",
    refresh
  }) as { ok?: boolean; status?: CompanionStatus };
  if (response.ok && response.status) {
    companionStatus.value = response.status;
  }
}

async function cancelActiveCompanionDownload(): Promise<void> {
  const mediaId = companionStatus.value.active?.mediaId;
  if (!mediaId) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "fansly-mymedia:cancel-companion-download",
    mediaId
  }) as { ok?: boolean };
  if (response.ok) {
    status.value = "Cancelling the active full-quality video download…";
  }
}

function companionStatusLabel(): string {
  if (companionStatus.value.checking) {
    return "Checking…";
  }
  if (companionStatus.value.available) {
    return companionStatus.value.version
      ? `Connected · version ${companionStatus.value.version}`
      : "Connected";
  }
  return "Not available";
}

function pauseDownloads(): void {
  pauseDownloadBatch = true;
}

function handleStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
): void {
  if (areaName === "local" && changes[DOWNLOAD_REVISION_KEY]) {
    void refreshDownloadIndex();
  }
}

async function refreshDownloadIndex(): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "fansly-mymedia:get-download-index"
  }) as { ok?: boolean; index?: DownloadIndex };
  if (!response.ok || !response.index) return;
  downloadIndex.value = response.index;
  for (const item of library.value) {
    const state = downloadIndex.value[item.mediaId]?.state;
    if (state) item.state = state;
    if (state === "completed" || state === "failed") {
      selectedIds.value.delete(item.mediaId);
    }
  }
}

function updateItemState(mediaId: string, state: MediaItem["state"]): void {
  const item = library.value.find((candidate) => candidate.mediaId === mediaId);
  if (item) item.state = state;
}

function countMedia(kind: MediaKind): number {
  return library.value.filter((item) =>
    item.kind === kind && item.state !== "completed" && item.state !== "failed").length;
}

function displayedFilename(record: DownloadRecord): string {
  return record.filename.replace(/^Fansly MyMedia\//, "");
}

function displayedOriginalFilename(record: DownloadRecord): string {
  return record.originalFilename ?? displayedFilename(record);
}

function displayCreatedAt(createdAt: number | undefined): string {
  return createdAt === undefined ? "Unknown date" : formatMediaCreatedAt(createdAt);
}

function displayPrice(price: number | undefined): string {
  return price === undefined ? "Unknown price" : `$${(price / 100).toFixed(2)}`;
}

async function saveSortOrder(): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY];
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...(typeof settings === "object" && settings !== null ? settings : {}),
      sortOrder: sortOrder.value
    }
  });
}

function downloadedKind(record: DownloadRecord): "Image" | "Video" | "Media" {
  const extension = record.filename.split(".").pop()?.toLowerCase();
  if (["jpeg", "jpg", "png", "gif", "webp", "avif"].includes(extension ?? "")) {
    return "Image";
  }
  if (["mp4", "m4v", "webm", "mov"].includes(extension ?? "")) {
    return "Video";
  }
  return "Media";
}

function recordsForHistoryTab(tab: string): DownloadRecord[] {
  if (tab === "downloaded") return downloadedRecords.value;
  if (tab === "failed") return failedRecords.value;
  return [];
}

async function fetchGroups(offset: number): Promise<{ groups: Group[] }> {
  const result = await command("groups", { offset });
  if (!result.ok) throw new Error(result.error ?? "Chat discovery failed.");
  return result.payload as { groups: Group[] };
}

async function fetchMedia(
  groupId: string,
  before: string
): Promise<{ offers: { id: string }[]; accountMediaCount: number; downloadableMedia?: unknown[] }> {
  const result = await command("media", { groupId, before });
  if (!result.ok) throw new Error(result.error ?? "Media collection failed.");
  return result.payload as {
    offers: { id: string }[];
    accountMediaCount: number;
    downloadableMedia?: unknown[];
  };
}

async function command(
  operation: "groups" | "media",
  extra: Record<string, unknown>
): Promise<BridgeResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(
      () => finish({ ok: false, error: "Request timed out." }),
      30_000
    );

    function listener(event: Event): void {
      const value = (event as CustomEvent<{
        requestId?: string;
        ok?: boolean;
        payload?: unknown;
        error?: string;
      }>).detail;
      if (value?.requestId === requestId) {
        finish({
          ok: value.ok === true,
          payload: value.payload,
          error: value.error
        });
      }
    }

    function finish(result: BridgeResult): void {
      window.clearTimeout(timeout);
      window.removeEventListener("fansly-mymedia:result", listener);
      resolve(result);
    }

    window.addEventListener("fansly-mymedia:result", listener);
    window.dispatchEvent(new CustomEvent("fansly-mymedia:command", {
      detail: {
        type: "fansly-mymedia:command",
        requestId,
        operation,
        ...extra
      }
    }));
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
</script>

<template>
  <button
    v-if="!isOpen"
    class="
      fixed bottom-5 left-5 z-2147483647 rounded-full bg-violet-600 px-5 py-3
      font-sans text-sm font-semibold text-white shadow-xl transition
      hover:bg-violet-500
      focus:ring-2 focus:ring-violet-300 focus:outline-none
    "
    type="button"
    @click="openLibrary"
  >
    MyMedia
  </button>

  <section
    v-else
    class="
      fixed inset-[3vh_3vw] z-2147483647 flex flex-col overflow-hidden
      rounded-2xl border border-white/10 bg-zinc-950 font-sans text-zinc-100
      antialiased shadow-2xl
    "
    role="dialog"
    aria-label="Fansly MyMedia library"
  >
    <header class="flex items-center gap-3 border-b border-white/10 px-6 py-4">
      <div class="mr-auto">
        <p class="text-xs font-medium tracking-wider text-violet-300 uppercase">
          Fansly
        </p>
        <h1 class="text-xl font-semibold tracking-tight">
          MyMedia Library
        </h1>
      </div>
      <button
        class="
          rounded-lg bg-zinc-800 px-3 py-2 text-sm transition
          hover:bg-zinc-700
        "
        type="button"
        aria-label="Settings"
        @click="isSettingsOpen = !isSettingsOpen"
      >
        ⚙
      </button>
      <button
        class="
          rounded-lg bg-zinc-800 px-3 py-2 text-sm transition
          hover:bg-zinc-700
        "
        type="button"
        aria-label="Close"
        @click="isOpen = false"
      >
        ×
      </button>
    </header>

    <div
      v-if="isSettingsOpen"
      class="grid max-w-xl gap-5 p-6"
    >
      <div>
        <h2 class="text-lg font-semibold">
          Collection settings
        </h2>
        <p class="mt-1 text-sm text-zinc-400">
          Limits and delay preferences apply to future collection runs.
        </p>
      </div>
      <section class="rounded-xl border border-white/10 bg-zinc-900 p-4">
        <div class="flex items-start gap-3">
          <span
            class="mt-1 size-2.5 shrink-0 rounded-full"
            :class="companionStatus.available ? 'bg-emerald-400' : 'bg-zinc-600'"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-medium text-zinc-100">
              Full-quality video companion
            </h3>
            <p class="mt-1 text-xs text-zinc-400">
              {{ companionStatusLabel() }}
            </p>
            <p
              v-if="companionStatus.error && !companionStatus.available"
              class="mt-2 text-xs text-amber-300"
            >
              {{ companionStatus.error }}
            </p>
          </div>
          <button
            class="
              rounded-lg bg-zinc-800 px-3 py-2 text-xs transition
              hover:bg-zinc-700
              disabled:cursor-wait disabled:opacity-50
            "
            type="button"
            :disabled="companionStatus.checking"
            @click="refreshCompanionStatus(true)"
          >
            Check connection
          </button>
        </div>
        <div
          v-if="companionStatus.active"
          class="mt-4"
        >
          <div class="flex justify-between text-xs text-zinc-400">
            <span>Downloading full-quality video</span>
            <span>{{ Math.round(companionStatus.active.percent ?? 0) }}%</span>
          </div>
          <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              class="h-full rounded-full bg-violet-500 transition-all"
              :style="{ width: `${companionStatus.active.percent ?? 0}%` }"
            />
          </div>
          <button
            class="
              mt-3 rounded-lg bg-red-950 px-3 py-2 text-xs text-red-200
              transition
              hover:bg-red-900
            "
            type="button"
            @click="cancelActiveCompanionDownload"
          >
            Cancel active download
          </button>
        </div>
      </section>
      <label class="grid gap-2 text-sm">
        Chat limit
        <input
          v-model.number="chatLimit"
          class="rounded-lg border border-white/10 bg-zinc-900 px-3 py-2"
          type="number"
          min="1"
          max="100000"
        >
        <span class="text-xs text-zinc-500">
          Only the first {{ chatLimit }} chats will be scanned for media.
        </span>
      </label>
      <label class="grid gap-2 text-sm">
        Minimum delay (seconds)
        <input
          v-model.number="minDelay"
          class="rounded-lg border border-white/10 bg-zinc-900 px-3 py-2"
          type="number"
          min="1"
        >
      </label>
      <label class="grid gap-2 text-sm">
        Maximum delay (seconds)
        <input
          v-model.number="maxDelay"
          class="rounded-lg border border-white/10 bg-zinc-900 px-3 py-2"
          type="number"
          min="1"
        >
      </label>
      <label class="grid gap-2 text-sm">
        Downloads subfolder
        <input
          v-model="downloadDirectory"
          class="rounded-lg border border-white/10 bg-zinc-900 px-3 py-2"
          type="text"
          autocomplete="off"
          placeholder="Fansly MyMedia"
        >
        <span class="text-xs text-zinc-500">
          Relative to Chrome's and Windows' Downloads folders. Nested paths such
          as Media/Fansly are supported.
        </span>
      </label>
      <label
        class="
          flex items-start gap-3 rounded-xl border border-white/10 bg-zinc-900
          p-4
        "
      >
        <input
          v-model="companionDebug"
          class="mt-0.5 size-4 accent-violet-500"
          type="checkbox"
        >
        <span>
          <span class="block text-sm font-medium text-zinc-100">
            Detailed companion diagnostics
          </span>
          <span class="mt-1 block text-xs/5 text-zinc-400">
            Captures verbose FFprobe and FFmpeg output plus a sanitized manifest
            response. Signed URL queries and authorization values remain redacted.
          </span>
        </span>
      </label>
      <button
        class="
          justify-self-start rounded-lg bg-violet-600 px-4 py-2 text-sm
          font-medium transition
          hover:bg-violet-500
        "
        type="button"
        @click="saveSettings"
      >
        Save settings
      </button>
    </div>

    <template v-else>
      <div class="flex items-center gap-4 border-b border-white/10 px-6 py-3">
        <div class="min-w-0 flex-1">
          <div class="flex justify-between text-xs text-zinc-400">
            <span>{{ groups.length }} chats · {{ library.length }} media</span>
            <span>{{ collectionProgress }}%</span>
          </div>
          <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              class="h-full rounded-full bg-violet-500 transition-all"
              :style="{ width: `${collectionProgress}%` }"
            />
          </div>
        </div>
        <button
          class="
            rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium transition
            hover:bg-violet-500
          "
          type="button"
          @click="isCollecting ? pauseCollection() : collectLibrary()"
        >
          {{ isCollecting ? "Pause" : isCollectionPaused ? "Resume" : "Refresh" }}
        </button>
      </div>

      <TabsRoot
        v-model="activeTab"
        class="flex min-h-0 flex-1 flex-col"
      >
        <TabsList class="flex gap-1 border-b border-white/10 px-6">
          <TabsTrigger
            class="
              border-b-2 border-transparent px-4 py-3 text-sm text-zinc-400
              data-[state=active]:border-violet-400
              data-[state=active]:text-white
            "
            value="image"
          >
            Images <span class="ml-1 text-xs">{{ imageCount }}</span>
          </TabsTrigger>
          <TabsTrigger
            class="
              border-b-2 border-transparent px-4 py-3 text-sm text-zinc-400
              data-[state=active]:border-violet-400
              data-[state=active]:text-white
            "
            value="video"
          >
            Videos <span class="ml-1 text-xs">{{ videoCount }}</span>
          </TabsTrigger>
          <TabsTrigger
            class="
              border-b-2 border-transparent px-4 py-3 text-sm text-zinc-400
              data-[state=active]:border-emerald-400
              data-[state=active]:text-white
            "
            value="downloaded"
          >
            Downloaded <span class="ml-1 text-xs">{{ downloadedCount }}</span>
          </TabsTrigger>
          <TabsTrigger
            class="
              border-b-2 border-transparent px-4 py-3 text-sm text-zinc-400
              data-[state=active]:border-red-400 data-[state=active]:text-white
            "
            value="failed"
          >
            Failed <span class="ml-1 text-xs">{{ failedCount }}</span>
          </TabsTrigger>
          <label class="ml-auto flex items-center gap-2 text-xs text-zinc-400">
            Sort
            <select
              v-model="sortOrder"
              class="
                rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm
                text-zinc-200
              "
              @change="saveSortOrder"
            >
              <option value="created-desc">Newest first</option>
              <option value="created-asc">Oldest first</option>
              <option value="price-desc">Price: high to low</option>
              <option value="price-asc">Price: low to high</option>
              <option value="likes-desc">Likes: high to low</option>
              <option value="likes-asc">Likes: low to high</option>
            </select>
          </label>
        </TabsList>

        <TabsContent
          v-for="tab in ['image', 'video', 'downloaded', 'failed']"
          :key="tab"
          :value="tab"
          class="min-h-0 flex-1 overflow-auto p-6"
        >
          <div
            v-if="recordsForHistoryTab(tab).length"
            class="grid gap-3"
          >
            <article
              v-for="record in recordsForHistoryTab(tab)"
              :key="record.mediaId"
              class="
                flex items-center gap-4 rounded-xl border border-white/10
                bg-zinc-900 p-4
              "
            >
              <DownloadThumbnail
                :media-id="record.mediaId"
                :kind="downloadedKind(record)"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-zinc-100">
                  {{ displayedOriginalFilename(record) }}
                </p>
                <p class="mt-1 truncate text-xs text-zinc-500">
                  {{ displayedFilename(record) }}
                </p>
                <p
                  class="
                    mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400
                  "
                >
                  <span>{{ displayCreatedAt(record.createdAt) }}</span>
                  <span>{{ displayPrice(record.price) }}</span>
                  <span>{{ record.likeCount ?? "—" }} likes</span>
                </p>
              </div>
              <span
                v-if="tab === 'downloaded'"
                class="
                  rounded-full bg-emerald-500/10 px-3 py-1 text-xs
                  text-emerald-300
                "
              >
                Completed
              </span>
              <div
                v-else
                class="flex max-w-72 flex-col items-end gap-2"
              >
                <span class="text-right text-xs text-red-300">
                  {{ record.error ?? "Download failed." }}
                </span>
                <button
                  class="
                    rounded-lg bg-red-950 px-3 py-2 text-xs text-red-200
                    transition
                    hover:bg-red-900
                    disabled:cursor-not-allowed disabled:opacity-40
                  "
                  type="button"
                  :disabled="isDownloading"
                  @click="retryFailed(record.mediaId)"
                >
                  Retry
                </button>
              </div>
            </article>
          </div>
          <div
            v-else-if="tab !== 'downloaded' && tab !== 'failed' && visibleMedia.length"
            class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4"
          >
            <button
              v-for="item in visibleMedia"
              :key="item.mediaId"
              class="
                group overflow-hidden rounded-xl border border-white/10
                bg-zinc-900 transition outline-none
                hover:border-violet-400/60
                focus-visible:border-violet-400 focus-visible:ring-2
                focus-visible:ring-violet-400/40
              "
              type="button"
              role="checkbox"
              :aria-checked="selectedIds.has(item.mediaId)"
              :aria-disabled="item.state !== 'ready'"
              :tabindex="item.state === 'ready' ? 0 : -1"
              @pointerenter="hoveredMediaId = item.mediaId"
              @pointerleave="hoveredMediaId = null"
              @focus="focusedMediaId = item.mediaId"
              @blur="focusedMediaId = null"
              @click="toggleCardFromKeyboard(item)"
            >
              <div class="relative aspect-square bg-zinc-800">
                <VideoStripePreview
                  v-if="item.kind === 'video'"
                  :preview-url="item.previewUrl"
                  :stripe-url="item.stripeUrl"
                  :frame-width="item.stripeFrameWidth"
                  :frame-height="item.stripeFrameHeight"
                  :active="
                    hoveredMediaId === item.mediaId
                      || focusedMediaId === item.mediaId
                  "
                />
                <img
                  v-else-if="item.previewUrl"
                  class="size-full object-cover"
                  :src="item.previewUrl"
                  loading="lazy"
                  alt=""
                >
                <div
                  v-else
                  class="
                    grid size-full place-items-center text-sm text-zinc-500
                  "
                >
                  No preview
                </div>
                <span
                  class="
                    absolute top-3 left-3 grid size-5 place-items-center
                    rounded-sm border border-white/70 text-xs text-white
                  "
                  :class="selectedIds.has(item.mediaId)
                    ? 'bg-violet-600'
                    : 'bg-black/50'"
                  aria-hidden="true"
                >
                  {{ selectedIds.has(item.mediaId) ? "✓" : "" }}
                </span>
                <span
                  v-if="item.kind === 'video'"
                  class="
                    absolute right-3 bottom-3 rounded-sm bg-black/70 px-2 py-1
                    text-xs
                  "
                >Video</span>
              </div>
              <div
                class="
                  grid grid-cols-3 gap-2 p-3 text-center text-xs text-zinc-400
                "
              >
                <span>{{ displayCreatedAt(item.createdAt) }}</span>
                <span>{{ displayPrice(item.price) }}</span>
                <span>{{ item.likeCount }} likes</span>
              </div>
            </button>
          </div>
          <div
            v-else
            class="
              grid h-full min-h-56 place-items-center text-sm text-zinc-500
            "
          >
            {{
              tab === "downloaded"
                ? "No completed downloads are stored yet."
                : tab === "failed"
                  ? "No failed downloads."
                  : isCollecting
                    ? "Media will appear here as it is discovered."
                    : "Nothing here yet."
            }}
          </div>
        </TabsContent>
      </TabsRoot>

      <footer
        class="
          flex items-center gap-3 border-t border-white/10 bg-zinc-950 px-6 py-4
        "
      >
        <span
          v-if="activeTab === 'image' || activeTab === 'video'"
          class="mr-auto text-sm text-zinc-400"
        >{{ selectedMedia.length }} selected</span>
        <span
          v-else
          class="mr-auto"
        />
        <button
          v-if="activeTab === 'failed'"
          class="
            rounded-lg bg-red-950 px-4 py-2 text-sm text-red-200 transition
            hover:bg-red-900
            disabled:cursor-not-allowed disabled:opacity-40
          "
          type="button"
          :disabled="failedCount === 0 || isDownloading"
          @click="retryAllFailed"
        >
          Retry all failed
        </button>
        <button
          v-if="activeTab === 'image' || activeTab === 'video'"
          class="
            rounded-lg bg-zinc-800 px-4 py-2 text-sm transition
            hover:bg-zinc-700
          "
          type="button"
          @click="clearSelection"
        >
          Clear
        </button>
        <button
          v-if="activeTab === 'image' || activeTab === 'video'"
          class="
            rounded-lg bg-zinc-800 px-4 py-2 text-sm transition
            hover:bg-zinc-700
          "
          type="button"
          @click="selectVisible"
        >
          Select visible
        </button>
        <button
          v-if="activeTab === 'image' || activeTab === 'video'"
          class="
            rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium transition
            hover:bg-violet-500
            disabled:cursor-not-allowed disabled:opacity-40
          "
          type="button"
          :disabled="selectedMedia.length === 0 || isDownloading"
          @click="downloadSelected"
        >
          Download selected
        </button>
        <button
          v-if="activeTab === 'image' || activeTab === 'video'"
          class="
            rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium transition
            hover:bg-amber-500
            disabled:cursor-not-allowed disabled:opacity-40
          "
          type="button"
          :disabled="!isDownloading"
          @click="pauseDownloads"
        >
          Pause batch
        </button>
      </footer>
    </template>

    <output class="border-t border-white/10 px-6 py-2 text-xs text-zinc-500">{{ status }}</output>
  </section>
</template>
