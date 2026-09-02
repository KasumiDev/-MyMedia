<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import {
  buildDownloadFilename,
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
type LibraryTab = MediaKind | "downloaded";

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
};

type MediaItem = DiscoveredMedia & {
  state: DownloadState | "ready";
};

type BridgeResult = {
  ok: boolean;
  payload?: unknown;
  error?: string;
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
const sortOrder = ref<MediaSortOrder>("created-desc");
const hoveredMediaId = ref<string | null>(null);
const focusedMediaId = ref<string | null>(null);

let collectionController: AbortController | null = null;
let pauseDownloadBatch = false;

const imageCount = computed(() => countMedia("image"));
const videoCount = computed(() => countMedia("video"));
const downloadedRecords = computed(() => sortMedia(
  Object.values(downloadIndex.value).filter((record) => record.state === "completed"),
  sortOrder.value
));
const downloadedCount = computed(() => downloadedRecords.value.length);
const collectionProgress = computed(() => groups.value.length === 0
  ? 0
  : Math.round((currentChat.value / groups.value.length) * 100));

const visibleMedia = computed(() => {
  if (activeTab.value === "downloaded") return [];
  return sortMedia(
    library.value.filter((item) => item.kind === activeTab.value && !isCompleted(item)),
    sortOrder.value
  );
});

const selectedMedia = computed(() => library.value.filter((item) =>
  selectedIds.value.has(item.mediaId) && item.state === "ready"));

onMounted(async () => {
  chrome.storage.onChanged.addListener(handleStorageChange);
  await Promise.all([refreshDownloadIndex(), loadSettings()]);
});

onBeforeUnmount(() => {
  collectionController?.abort();
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
  } | undefined;
  chatLimit.value = validInteger(settings?.chatLimit, 1, 100_000, DEFAULT_CHAT_LIMIT);
  minDelay.value = validInteger(settings?.minDelay, 1, 300, 1);
  maxDelay.value = validInteger(settings?.maxDelay, minDelay.value, 300, 5);
  sortOrder.value = isMediaSortOrder(settings?.sortOrder)
    ? settings.sortOrder
    : "created-desc";
}

async function saveSettings(): Promise<void> {
  chatLimit.value = validInteger(chatLimit.value, 1, 100_000, DEFAULT_CHAT_LIMIT);
  minDelay.value = validInteger(minDelay.value, 1, 300, 1);
  maxDelay.value = validInteger(maxDelay.value, minDelay.value, 300, 5);
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      chatLimit: chatLimit.value,
      minDelay: minDelay.value,
      maxDelay: maxDelay.value,
      sortOrder: sortOrder.value
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
      filename: buildDownloadFilename({
        mediaId: item.mediaId,
        createdAt: item.createdAt,
        extension: item.extension
      }),
      mediaId: item.mediaId,
      originalFilename: item.originalFilename,
      createdAt: item.createdAt,
      likeCount: item.likeCount,
      price: item.price
    }) as BridgeResult;
    updateItemState(item.mediaId, result.ok ? "downloading" : "failed");
  }

  isDownloading.value = false;
  status.value = pauseDownloadBatch
    ? "Download batch paused. Downloads already started continue in Chrome."
    : "Selected downloads submitted. Completed files move to Downloaded automatically.";
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
    if (state === "completed") selectedIds.value.delete(item.mediaId);
  }
}

function updateItemState(mediaId: string, state: MediaItem["state"]): void {
  const item = library.value.find((candidate) => candidate.mediaId === mediaId);
  if (item) item.state = state;
}

function countMedia(kind: MediaKind): number {
  return library.value.filter((item) => item.kind === kind && !isCompleted(item)).length;
}

function isCompleted(item: MediaItem): boolean {
  return item.state === "completed";
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
          v-for="tab in ['image', 'video', 'downloaded']"
          :key="tab"
          :value="tab"
          class="min-h-0 flex-1 overflow-auto p-6"
        >
          <div
            v-if="tab === 'downloaded' && downloadedRecords.length"
            class="grid gap-3"
          >
            <article
              v-for="record in downloadedRecords"
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
                class="
                  rounded-full bg-emerald-500/10 px-3 py-1 text-xs
                  text-emerald-300
                "
              >
                Completed
              </span>
            </article>
          </div>
          <div
            v-else-if="tab !== 'downloaded' && visibleMedia.length"
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
        <span class="mr-auto text-sm text-zinc-400">{{ selectedMedia.length }} selected</span>
        <button
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
