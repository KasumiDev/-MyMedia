<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import {
  LIKES_ALBUM_TYPE,
  PURCHASES_ALBUM_TYPE,
  type CollectionAlbum
} from "../core/albums";
import {
  buildDownloadFilename,
  DEFAULT_DOWNLOAD_DIRECTORY,
  normalizeDownloadDirectory,
  formatMediaCreatedAt,
  sanitizeFilenameComponent
} from "../core/filenames";
import { mergeUniqueMedia } from "../core/media-library";
import {
  includesChatMedia,
  mediaGroupingPath,
  type ChatMediaDirection,
  type CollectionSource
} from "../core/media-source";
import {
  isMediaSortOrder,
  sortMedia,
  type MediaSortOrder
} from "../core/media-sort";
import { paginateGroups, paginateMedia } from "../core/pagination";
import { BRIDGE_RELAY_REQUEST } from "../core/relay-protocol";
import {
  loadDownloadDirectoryHandle,
  saveDownloadDirectoryHandle
} from "../storage/download-directory";
import type {
  DownloadIndex,
  DownloadRecord,
  DownloadState
} from "../storage/download-index";
import DownloadThumbnail from "./DownloadThumbnail.vue";
import DownloadProgressToast from "./DownloadProgressToast.vue";
import VideoStripePreview from "./VideoStripePreview.vue";

const DOWNLOAD_REVISION_KEY = "fansly-mymedia:download-revision";
const SETTINGS_KEY = "fansly-mymedia:settings";
const SETTINGS_VERSION = 2;
const DEFAULT_CHAT_LIMIT = 25;

type Group = {
  groupId: string;
  partnerUsername: string;
  partnerAccountId: string;
};

type Album = CollectionAlbum;

type MediaSourceType = "chat" | "album";

type MediaKind = "image" | "video";
type LibraryTab = MediaKind | "downloaded" | "failed";

const collectionSourceOptions: ReadonlyArray<{
  value: CollectionSource;
  title: string;
  description: string;
}> = [
  {
    value: "chat",
    title: "Chat",
    description: "Media exchanged in selected chats."
  },
  {
    value: "liked",
    title: "Liked",
    description: "Media from your Likes collection."
  },
  {
    value: "purchased",
    title: "Purchased",
    description: "Media from your Purchases collection."
  }
];

const chatDirectionOptions: ReadonlyArray<{
  value: ChatMediaDirection;
  label: string;
}> = [
  { value: "sent", label: "Only Sent Media" },
  { value: "received", label: "Only Received Media" },
  { value: "all", label: "All" }
];

type DiscoveredMedia = {
  accountMediaId: string;
  mediaId: string;
  ownerAccountId: string;
  creatorName: string | null;
  mediaBundleId: string | null;
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
  sourceGroupId: string;
  sourceType: MediaSourceType;
  downloadSubdirectory: string;
  state: DownloadState | "ready";
};

type BridgeResult = {
  ok: boolean;
  mode?: "browser" | "browser-native" | "companion";
  payload?: unknown;
  error?: string;
};

const isSettingsOpen = ref(false);
const hasStarted = ref(false);
const isCollecting = ref(false);
const isCollectionPaused = ref(false);
const isLoadingChats = ref(false);
const isDownloading = ref(false);
const activeTab = ref<LibraryTab>("image");
const groups = ref<Group[]>([]);
const albums = ref<Album[]>([]);
const collectionSource = ref<CollectionSource>("chat");
const chatDirection = ref<ChatMediaDirection>("all");
const selectedChatIds = ref(new Set<string>());
const library = ref<MediaItem[]>([]);
const selectedIds = ref(new Set<string>());
const downloadIndex = ref<DownloadIndex>({});
const status = ref("Preparing the media library…");
const currentChat = ref(0);
const collectionSourceCount = ref(0);
const chatLimit = ref(DEFAULT_CHAT_LIMIT);
const minDelay = ref(1);
const maxDelay = ref(5);
const companionDebug = ref(false);
const downloadDirectory = ref(DEFAULT_DOWNLOAD_DIRECTORY);
const downloadFolderName = ref<string | null>(null);
const folderDialogOpen = ref(false);
const folderDialogMessage = ref("");
const sortOrder = ref<MediaSortOrder>("created-desc");
const hoveredMediaId = ref<string | null>(null);
const focusedMediaId = ref<string | null>(null);

let collectionController: AbortController | null = null;
let pauseDownloadBatch = false;
let directoryHandle: FileSystemDirectoryHandle | null = null;
let folderDialogPromise: Promise<boolean> | null = null;
let folderDialogResolver: ((selected: boolean) => void) | null = null;

type PermissionState = "granted" | "denied" | "prompt";
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  values(): AsyncIterableIterator<unknown>;
};

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
const collectionProgress = computed(() => collectionSourceCount.value === 0
  ? 0
  : Math.round((currentChat.value / collectionSourceCount.value) * 100));

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
const canStartCollection = computed(() => collectionSource.value !== "chat"
  || selectedChatIds.value.size > 0);

onMounted(async () => {
  chrome.storage.onChanged.addListener(handleStorageChange);
  const [, , handle] = await Promise.all([
    refreshDownloadIndex(),
    loadSettings(),
    loadDownloadDirectoryHandle()
  ]);
  directoryHandle = handle;
  downloadFolderName.value = handle?.name ?? null;
  if (handle) downloadDirectory.value = normalizeDownloadDirectory(handle.name);
  await loadChatsForSelection();
});

onBeforeUnmount(() => {
  collectionController?.abort();
  settleFolderDialog(false);
  chrome.storage.onChanged.removeListener(handleStorageChange);
});

async function collectLibrary(): Promise<void> {
  collectionController?.abort();
  collectionController = new AbortController();
  isCollecting.value = true;
  isCollectionPaused.value = false;
  currentChat.value = 0;
  collectionSourceCount.value = 0;
  status.value = "Preparing collection…";

  try {
    albums.value = [];
    const selectedGroups = collectionSource.value === "chat"
      ? groups.value.filter((group) => selectedChatIds.value.has(group.groupId))
      : [];
    const needsReceivedMedia = chatDirection.value !== "sent";
    const missingPartner = selectedGroups.find((group) =>
      needsReceivedMedia && !group.partnerAccountId);
    if (missingPartner) {
      throw new Error(
        `Fansly did not return the partner account for ${missingPartner.partnerUsername || missingPartner.groupId}. Refresh the chat list and try again.`
      );
    }
    const chatScans = selectedGroups.flatMap((group) => {
      const scans: Array<{
        group: Group;
        accountId?: string;
        direction: "sent" | "received";
      }> = [];
      if (chatDirection.value !== "received") {
        scans.push({ group, direction: "sent" });
      }
      if (chatDirection.value !== "sent") {
        scans.push({
          group,
          accountId: group.partnerAccountId,
          direction: "received"
        });
      }
      return scans;
    });
    if (collectionSource.value !== "chat") {
      status.value = "Discovering media collections…";
      const response = await fetchAlbums();
      const targetType = collectionSource.value === "liked"
        ? LIKES_ALBUM_TYPE
        : PURCHASES_ALBUM_TYPE;
      albums.value = response.albums.filter((album) => album.type === targetType);
      await chrome.storage.local.set({ "fansly-mymedia:albums": albums.value });
    }
    collectionSourceCount.value = chatScans.length + albums.value.length;

    for (const [index, scan] of chatScans.entries()) {
      if (collectionController.signal.aborted) break;
      currentChat.value = index + 1;
      status.value = `Collecting ${scan.direction} media from ${scan.group.partnerUsername || scan.group.groupId}…`;
      await paginateMedia(
        (before) => fetchMedia(
          scan.group.groupId,
          before,
          scan.accountId
        ),
        {
          signal: collectionController.signal,
          onPage: (page) => addMedia(
            page.downloadableMedia as DiscoveredMedia[] | undefined,
            scan.group.groupId,
            "chat",
            page.viewerAccountId
          )
        }
      );
    }

    for (const [index, album] of albums.value.entries()) {
      if (collectionController.signal.aborted) break;
      currentChat.value = chatScans.length + index + 1;
      status.value = `Collecting ${album.title}…`;
      await paginateMedia(
        (before) => fetchAlbumMedia(album.id, before),
        {
          signal: collectionController.signal,
          onPage: (page) => addMedia(
            page.downloadableMedia as DiscoveredMedia[] | undefined,
            album.id,
            "album"
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

async function loadChatsForSelection(): Promise<void> {
  collectionController?.abort();
  collectionController = new AbortController();
  isLoadingChats.value = true;
  status.value = `Loading up to ${chatLimit.value} chats…`;
  try {
    groups.value = await paginateGroups(fetchGroups, {
      pageSize: 30,
      limit: chatLimit.value,
      signal: collectionController.signal
    });
    selectedChatIds.value = new Set();
    await chrome.storage.local.set({ "fansly-mymedia:chats": groups.value });
    status.value = `${groups.value.length} chats loaded. Select one or more chats.`;
  } catch (error) {
    status.value = errorMessage(error, "Chat discovery failed.");
  } finally {
    isLoadingChats.value = false;
  }
}

async function selectCollectionSource(source: CollectionSource): Promise<void> {
  collectionSource.value = source;
  if (source === "chat" && groups.value.length === 0) {
    await loadChatsForSelection();
    return;
  }
  status.value = source === "chat"
    ? "Select one or more chats."
    : `Ready to collect ${source} media.`;
}

function toggleChat(groupId: string): void {
  const next = new Set(selectedChatIds.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  selectedChatIds.value = next;
}

function selectAllChats(): void {
  selectedChatIds.value = new Set(groups.value.map((group) => group.groupId));
}

function clearChatSelection(): void {
  selectedChatIds.value = new Set();
}

async function startCollection(): Promise<void> {
  if (!canStartCollection.value) return;
  hasStarted.value = true;
  library.value = [];
  selectedIds.value = new Set();
  await collectLibrary();
}

function changeCollectionSource(): void {
  collectionController?.abort();
  isCollecting.value = false;
  isCollectionPaused.value = false;
  hasStarted.value = false;
  status.value = "Choose what you want to collect.";
}

function pauseCollection(): void {
  collectionController?.abort();
  isCollectionPaused.value = true;
}

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY] as {
    settingsVersion?: unknown;
    chatLimit?: unknown;
    minDelay?: unknown;
    maxDelay?: unknown;
    sortOrder?: unknown;
    companionDebug?: unknown;
    downloadDirectory?: unknown;
  } | undefined;
  const storedChatLimit = settings?.settingsVersion !== SETTINGS_VERSION
    && settings?.chatLimit === 10
    ? DEFAULT_CHAT_LIMIT
    : settings?.chatLimit;
  chatLimit.value = validInteger(storedChatLimit, 1, 100_000, DEFAULT_CHAT_LIMIT);
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
      settingsVersion: SETTINGS_VERSION,
      chatLimit: chatLimit.value,
      minDelay: minDelay.value,
      maxDelay: maxDelay.value,
      sortOrder: sortOrder.value,
      companionDebug: companionDebug.value,
      downloadDirectory: downloadDirectory.value
    }
  });
  status.value = `Settings saved. The next collection will process up to ${chatLimit.value} chats.`;
  if (!hasStarted.value && collectionSource.value === "chat") {
    await loadChatsForSelection();
  }
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

function addMedia(
  items: DiscoveredMedia[] | undefined,
  sourceGroupId: string,
  sourceType: MediaSourceType,
  viewerAccountId = ""
): void {
  if (!items) return;
  const filteredItems = sourceType === "chat"
    ? items.filter((item) => includesChatMedia(
        item.ownerAccountId,
        viewerAccountId,
        chatDirection.value
      ))
    : items;
  const additions: MediaItem[] = filteredItems.map((item) => ({
    ...item,
    sourceGroupId,
    sourceType,
    downloadSubdirectory: groupingDirectory(
      item,
      sourceGroupId,
      sourceType,
      viewerAccountId
    ),
    state: downloadIndex.value[item.mediaId]?.state ?? "ready"
  }));
  library.value = mergeUniqueMedia(library.value, additions);
}

function groupingDirectory(
  item: DiscoveredMedia,
  sourceGroupId: string,
  sourceType: MediaSourceType,
  viewerAccountId: string
): string {
  const chatName = groups.value.find((group) =>
    group.groupId === sourceGroupId)?.partnerUsername;
  const source = sourceType === "chat" ? "chat" : collectionSource.value;
  return mediaGroupingPath({
    source,
    ownerAccountId: item.ownerAccountId,
    creatorName: item.creatorName,
    viewerAccountId,
    chatName,
    mediaBundleId: item.mediaBundleId
  })
    .map((component) => sanitizeFilenameComponent(component))
    .join("/");
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
  if (!(await ensureDownloadFolder())) return;
  isDownloading.value = true;
  pauseDownloadBatch = false;

  for (const item of selectedMedia.value) {
    if (pauseDownloadBatch) break;
    await queueMediaDownload(item);
  }

  isDownloading.value = false;
  status.value = pauseDownloadBatch
    ? "Download batch paused. Downloads already started continue in Chrome."
    : "Selected downloads submitted. Completed files move to Downloaded automatically.";
}

async function retryFailed(mediaId: string): Promise<void> {
  const record = downloadIndex.value[mediaId];
  if (!record) return;
  if (!(await ensureDownloadFolder())) return;
  isDownloading.value = true;
  status.value = `Refreshing media ${mediaId} before retry…`;
  try {
    const refreshed = await rediscoverFailedRecords([record]);
    const item = refreshed.get(mediaId);
    if (!item) throw new Error("The media could not be found in its chat.");
    const response = await queueMediaDownload(item, mediaId);
    status.value = response.ok
      ? "Fresh media URL found. Retry queued."
      : response.error ?? "The download could not be retried.";
  } catch (error) {
    status.value = errorMessage(error, "The download could not be rediscovered.");
  } finally {
    isDownloading.value = false;
    await refreshDownloadIndex();
  }
}

async function retryAllFailed(): Promise<void> {
  if (!(await ensureDownloadFolder())) return;
  isDownloading.value = true;
  status.value = `Retrying ${failedCount.value} failed downloads…`;
  const records = [...failedRecords.value];
  let retried = 0;
  try {
    const refreshed = await rediscoverFailedRecords(records);
    for (const record of records) {
      const item = refreshed.get(record.mediaId);
      if (!item) continue;
      const response = await queueMediaDownload(item, record.mediaId);
      if (response.ok) retried += 1;
    }
    status.value = `${retried} retries queued; ${records.length - retried} unavailable.`;
  } catch (error) {
    status.value = errorMessage(error, "Failed downloads could not be rediscovered.");
  } finally {
    isDownloading.value = false;
    await refreshDownloadIndex();
  }
}

async function queueMediaDownload(
  item: MediaItem,
  historyMediaId = item.mediaId
): Promise<BridgeResult> {
  updateItemState(historyMediaId, "queued");
  const groupedDownloadDirectory = normalizeDownloadDirectory(
    `${downloadDirectory.value}/${item.downloadSubdirectory}`
  );
  const result = await chrome.runtime.sendMessage({
    type: "fansly-mymedia:download",
    url: item.url,
    previewUrl: item.previewUrl ?? (item.kind === "image" ? item.url : null),
    manifestUrl: item.kind === "video" ? item.manifestUrl : null,
    filename: buildDownloadFilename({
      mediaId: historyMediaId,
      createdAt: item.createdAt,
      extension: item.extension,
      downloadDirectory: groupedDownloadDirectory
    }),
    downloadDirectory: downloadDirectory.value,
    mediaId: historyMediaId,
    accountMediaId: item.accountMediaId,
    sourceGroupId: item.sourceGroupId,
    sourceType: item.sourceType,
    originalFilename: item.originalFilename,
    createdAt: item.createdAt,
    likeCount: item.likeCount,
    price: item.price,
    debug: companionDebug.value
  }) as BridgeResult;
  updateItemState(historyMediaId, result.ok ? "downloading" : "failed");
  return result;
}

async function rediscoverFailedRecords(
  records: DownloadRecord[]
): Promise<Map<string, MediaItem>> {
  const found = new Map<string, MediaItem>();
  const retryGroups = await loadRetryGroups();
  const knownBySource = new Map<string, {
    id: string;
    type: MediaSourceType;
    accountId?: string;
    records: DownloadRecord[];
  }>();
  const unknown: DownloadRecord[] = [];

  for (const record of records) {
    const current = library.value.find((item) => item.mediaId === record.mediaId);
    const sourceId = record.sourceGroupId ?? current?.sourceGroupId;
    const sourceType = record.sourceType ?? current?.sourceType ?? "chat";
    if (!sourceId) {
      unknown.push(record);
      continue;
    }
    const accountId = sourceType === "chat"
      && record.filename.includes("/Received/")
      ? retryGroups.find((group) =>
          group.groupId === sourceId)?.partnerAccountId
      : undefined;
    const key = `${sourceType}:${sourceId}:${accountId ?? "viewer"}`;
    const source = knownBySource.get(key) ?? {
      id: sourceId,
      type: sourceType,
      accountId,
      records: []
    };
    source.records.push(record);
    knownBySource.set(key, source);
  }

  for (const source of knownBySource.values()) {
    status.value = `Refreshing ${source.records.length} failed media from ${source.type} ${source.id}…`;
    const matches = await findMediaInSource(
      source.id,
      source.type,
      source.records,
      source.accountId
    );
    for (const [mediaId, item] of matches) found.set(mediaId, item);
  }

  if (unknown.length > 0) {
    for (const group of retryGroups) {
      const unresolved = unknown.filter((record) => !found.has(record.mediaId));
      if (unresolved.length === 0) break;
      status.value = `Locating ${unresolved.length} failed media in ${group.partnerUsername || group.groupId}…`;
      const matches = await findMediaInSource(group.groupId, "chat", unresolved);
      for (const [mediaId, item] of matches) found.set(mediaId, item);
    }
  }

  return found;
}

async function findMediaInSource(
  sourceId: string,
  sourceType: MediaSourceType,
  targets: DownloadRecord[],
  accountId?: string
): Promise<Map<string, MediaItem>> {
  const found = new Map<string, MediaItem>();
  const visited = new Set<string>();
  let before = "";

  for (;;) {
    const page = sourceType === "album"
      ? await fetchAlbumMedia(sourceId, before)
      : await fetchMedia(sourceId, before, accountId);
    const items = (page.downloadableMedia ?? []) as DiscoveredMedia[];
    for (const record of targets) {
      if (found.has(record.mediaId)) continue;
      const current = library.value.find((item) => item.mediaId === record.mediaId);
      const accountMediaId = record.accountMediaId ?? current?.accountMediaId;
      const match = items.find((item) => item.mediaId === record.mediaId
        || (accountMediaId !== undefined && item.accountMediaId === accountMediaId));
      if (match) {
        found.set(record.mediaId, {
          ...match,
          sourceGroupId: sourceId,
          sourceType,
          downloadSubdirectory: storedGroupingDirectory(record),
          state: "ready"
        });
      }
    }
    if (found.size === targets.length || page.offers.length === 0) return found;
    const next = page.offers.at(-1)?.id;
    if (!next || visited.has(next)) return found;
    visited.add(next);
    before = next;
  }
}

function storedGroupingDirectory(record: DownloadRecord): string {
  const components = record.filename.split("/");
  return components.length > 2
    ? components.slice(1, -1).join("/")
    : "Recovered";
}

async function loadRetryGroups(): Promise<Group[]> {
  if (groups.value.length > 0) return groups.value;
  const stored = await chrome.storage.local.get("fansly-mymedia:chats");
  const value = stored["fansly-mymedia:chats"];
  if (!Array.isArray(value)) return [];
  return value.filter((group): group is Group => {
    if (!group || typeof group !== "object") return false;
    const candidate = group as Partial<Group>;
    return typeof candidate.groupId === "string"
      && /^\d{6,30}$/u.test(candidate.groupId)
      && typeof candidate.partnerUsername === "string"
      && typeof candidate.partnerAccountId === "string";
  });
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
  if (areaName === "local" && changes[SETTINGS_KEY]) {
    void Promise.all([
      loadSettings(),
      loadDownloadDirectoryHandle().then((handle) => {
        directoryHandle = handle;
        downloadFolderName.value = handle?.name ?? null;
      })
    ]);
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

async function fetchAlbums(): Promise<{ albums: Album[] }> {
  const result = await command("albums", {});
  if (!result.ok) throw new Error(result.error ?? "Album discovery failed.");
  return result.payload as { albums: Album[] };
}

async function fetchMedia(
  groupId: string,
  before: string,
  accountId?: string
): Promise<{
  offers: { id: string }[];
  accountMediaCount: number;
  viewerAccountId?: string;
  downloadableMedia?: unknown[];
}> {
  const result = await command("media", {
    groupId,
    before,
    ...(accountId ? { accountId } : {})
  });
  if (!result.ok) throw new Error(result.error ?? "Media collection failed.");
  return result.payload as {
    offers: { id: string }[];
    accountMediaCount: number;
    viewerAccountId?: string;
    downloadableMedia?: unknown[];
  };
}

async function fetchAlbumMedia(
  albumId: string,
  before: string
): Promise<{
  offers: { id: string }[];
  accountMediaCount: number;
  downloadableMedia?: unknown[];
}> {
  const result = await command("albumMedia", { albumId, before });
  if (!result.ok) throw new Error(result.error ?? "Album collection failed.");
  return result.payload as {
    offers: { id: string }[];
    accountMediaCount: number;
    downloadableMedia?: unknown[];
  };
}

async function command(
  operation: "groups" | "media" | "albums" | "albumMedia",
  extra: Record<string, unknown>
): Promise<BridgeResult> {
  const tabs = await chrome.tabs.query({ url: "https://fansly.com/*" });
  const tab = tabs
    .filter((candidate) => candidate.id !== undefined)
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
  if (tab?.id === undefined) {
    return {
      ok: false,
      error: "Open and sign in to Fansly in another tab, then try again."
    };
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, {
      type: BRIDGE_RELAY_REQUEST,
      operation,
      ...extra
    }) as BridgeResult;
  } catch {
    return {
      ok: false,
      error: "Refresh the open Fansly tab so the extension can connect to it."
    };
  }
}

async function ensureDownloadFolder(): Promise<boolean> {
  if (!directoryHandle) {
    return requestDownloadFolder(
      "Select a folder before starting the download."
    );
  }
  if (await isDirectoryAvailable(directoryHandle)) return true;
  status.value = "Choose an available download folder before downloading.";
  return requestDownloadFolder(
    "The previous download folder is unavailable. Select it again or choose another folder."
  );
}

async function chooseDownloadFolder(): Promise<boolean> {
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
    downloadFolderName.value = handle.name;
    downloadDirectory.value = sanitizeFilenameComponent(handle.name, "Downloads");
    await saveDownloadFolderName(downloadDirectory.value);
    status.value = `Downloads will be saved directly in ${handle.name}.`;
    return true;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      status.value = errorMessage(error, "Chrome could not open that folder.");
    }
    return false;
  }
}

function requestDownloadFolder(message: string): Promise<boolean> {
  if (folderDialogPromise) return folderDialogPromise;
  folderDialogMessage.value = message;
  folderDialogOpen.value = true;
  folderDialogPromise = new Promise<boolean>((resolve) => {
    folderDialogResolver = resolve;
  });
  return folderDialogPromise;
}

async function confirmDownloadFolder(): Promise<void> {
  if (await chooseDownloadFolder()) settleFolderDialog(true);
}

function settleFolderDialog(selected: boolean): void {
  folderDialogOpen.value = false;
  folderDialogResolver?.(selected);
  folderDialogResolver = null;
  folderDialogPromise = null;
}

function handleDownloadFolderRequired(): void {
  void requestDownloadFolder(
    "The download folder can no longer be accessed. Select it again to continue the queued downloads."
  );
}

async function isDirectoryAvailable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const permissionHandle = handle as PermissionHandle;
    if (await permissionHandle.queryPermission({ mode: "readwrite" }) !== "granted") {
      return false;
    }
    await permissionHandle.values().next();
    return true;
  } catch {
    return false;
  }
}

async function saveDownloadFolderName(name: string): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY];
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...(settings && typeof settings === "object" ? settings : {}),
      downloadDirectory: name
    }
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
</script>

<template>
  <section
    class="
      flex h-screen flex-col overflow-hidden bg-zinc-950 font-sans text-zinc-100
      antialiased
    "
    role="main"
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
          max-w-64 rounded-lg bg-zinc-800 px-3 py-2 text-left text-sm transition
          hover:bg-zinc-700
        "
        type="button"
        @click="chooseDownloadFolder"
      >
        <span class="block text-[0.65rem] text-zinc-500 uppercase">
          Download folder
        </span>
        <span class="block truncate">
          {{ downloadFolderName ?? "Select folder" }}
        </span>
      </button>
      <button
        class="
          flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-sm
          transition
          hover:bg-zinc-700
        "
        type="button"
        aria-label="Settings"
        @click="isSettingsOpen = !isSettingsOpen"
      >
        <span aria-hidden="true">⚙</span>
        <span>Settings</span>
      </button>
    </header>

    <div
      v-if="isSettingsOpen"
      class="grid max-w-xl gap-5 overflow-auto p-6"
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
          The first {{ chatLimit }} chats will be loaded into the source picker.
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
            Detailed browser diagnostics
          </span>
          <span class="mt-1 block text-xs/5 text-zinc-400">
            Captures HLS requests, response metadata, conversion details, and
            sanitized manifests in the download progress notification.
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

    <template v-else-if="hasStarted">
      <div class="flex items-center gap-4 border-b border-white/10 px-6 py-3">
        <div class="min-w-0 flex-1">
          <div class="flex justify-between text-xs text-zinc-400">
            <span>
              {{ groups.length }} chats
              <template v-if="albums.length"> · {{ albums.length }} collections</template>
              · {{ library.length }} media
            </span>
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
            rounded-lg bg-zinc-800 px-4 py-2 text-sm transition
            hover:bg-zinc-700
          "
          type="button"
          :disabled="isCollecting"
          @click="changeCollectionSource"
        >
          Change source
        </button>
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

    <main
      v-else
      class="min-h-0 flex-1 overflow-auto p-6"
    >
      <div class="mx-auto grid max-w-4xl gap-6">
        <div>
          <h2 class="text-2xl font-semibold tracking-tight">
            Choose media source
          </h2>
          <p class="mt-2 text-sm text-zinc-400">
            Select one source for this collection run. Download history remains
            available between runs.
          </p>
        </div>

        <fieldset
          class="
            grid gap-3
            sm:grid-cols-3
          "
        >
          <legend class="sr-only">
            Media source
          </legend>
          <button
            v-for="source in collectionSourceOptions"
            :key="source.value"
            class="
              rounded-xl border p-4 text-left transition
              hover:border-violet-400/60
            "
            :class="collectionSource === source.value
              ? 'border-violet-400 bg-violet-500/10'
              : 'border-white/10 bg-zinc-900'"
            type="button"
            @click="selectCollectionSource(source.value)"
          >
            <span class="block text-sm font-semibold text-zinc-100">
              {{ source.title }}
            </span>
            <span class="mt-1 block text-xs/5 text-zinc-400">
              {{ source.description }}
            </span>
          </button>
        </fieldset>

        <section
          v-if="collectionSource === 'chat'"
          class="grid gap-5 rounded-2xl border border-white/10 bg-zinc-900 p-5"
        >
          <fieldset class="grid gap-3">
            <legend class="text-sm font-medium text-zinc-200">
              Which messages should be included?
            </legend>
            <div class="flex flex-wrap gap-2">
              <label
                v-for="direction in chatDirectionOptions"
                :key="direction.value"
                class="
                  cursor-pointer rounded-lg border px-4 py-2 text-sm transition
                "
                :class="chatDirection === direction.value
                  ? 'border-violet-400 bg-violet-500/15 text-white'
                  : 'border-white/10 bg-zinc-950 text-zinc-400'"
              >
                <input
                  v-model="chatDirection"
                  class="sr-only"
                  type="radio"
                  name="chat-direction"
                  :value="direction.value"
                >
                {{ direction.label }}
              </label>
            </div>
          </fieldset>

          <div class="flex flex-wrap items-center gap-3">
            <div class="mr-auto">
              <h3 class="text-sm font-medium text-zinc-200">
                Select chats
              </h3>
              <p class="mt-1 text-xs text-zinc-500">
                {{ selectedChatIds.size }} of {{ groups.length }} selected
              </p>
            </div>
            <button
              class="
                rounded-lg bg-zinc-800 px-3 py-2 text-xs
                hover:bg-zinc-700
              "
              type="button"
              :disabled="isLoadingChats"
              @click="loadChatsForSelection"
            >
              {{ isLoadingChats ? "Loading…" : "Refresh chats" }}
            </button>
            <button
              class="
                rounded-lg bg-zinc-800 px-3 py-2 text-xs
                hover:bg-zinc-700
              "
              type="button"
              :disabled="groups.length === 0"
              @click="selectAllChats"
            >
              Select all
            </button>
            <button
              class="
                rounded-lg bg-zinc-800 px-3 py-2 text-xs
                hover:bg-zinc-700
              "
              type="button"
              :disabled="selectedChatIds.size === 0"
              @click="clearChatSelection"
            >
              Clear
            </button>
          </div>

          <div
            v-if="groups.length"
            class="
              grid max-h-80 gap-2 overflow-auto
              sm:grid-cols-2
            "
          >
            <label
              v-for="group in groups"
              :key="group.groupId"
              class="
                flex cursor-pointer items-center gap-3 rounded-lg border
                border-white/10 bg-zinc-950 p-3
                hover:border-white/20
              "
            >
              <input
                class="size-4 shrink-0 accent-violet-500"
                type="checkbox"
                :checked="selectedChatIds.has(group.groupId)"
                @change="toggleChat(group.groupId)"
              >
              <span class="min-w-0 truncate text-sm text-zinc-200">
                {{ group.partnerUsername || group.groupId }}
              </span>
            </label>
          </div>
          <div
            v-else
            class="grid min-h-24 place-items-center text-sm text-zinc-500"
          >
            {{ isLoadingChats ? "Loading chats…" : "No chats loaded." }}
          </div>
        </section>

        <div class="flex justify-end">
          <button
            class="
              rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium
              transition
              hover:bg-violet-500
              disabled:cursor-not-allowed disabled:opacity-40
            "
            type="button"
            :disabled="!canStartCollection || isLoadingChats"
            @click="startCollection"
          >
            Start collection
          </button>
        </div>
      </div>
    </main>

    <output class="border-t border-white/10 px-6 py-2 text-xs text-zinc-500">{{ status }}</output>
  </section>
  <div
    v-if="folderDialogOpen"
    class="fixed inset-0 z-60 grid place-items-center bg-black/70 p-6"
    role="dialog"
    aria-modal="true"
    aria-labelledby="folder-dialog-title"
  >
    <div
      class="
        w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-6
        shadow-2xl
      "
    >
      <h2
        id="folder-dialog-title"
        class="text-lg font-semibold text-zinc-100"
      >
        Select download folder
      </h2>
      <p class="mt-2 text-sm/6 text-zinc-400">
        {{ folderDialogMessage }}
      </p>
      <div class="mt-6 flex justify-end gap-3">
        <button
          class="
            rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 transition
            hover:bg-zinc-700
          "
          type="button"
          @click="settleFolderDialog(false)"
        >
          Cancel
        </button>
        <button
          class="
            rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white
            transition
            hover:bg-violet-500
          "
          type="button"
          @click="confirmDownloadFolder"
        >
          Select folder
        </button>
      </div>
    </div>
  </div>
  <DownloadProgressToast @folder-required="handleDownloadFolderRequired" />
</template>
