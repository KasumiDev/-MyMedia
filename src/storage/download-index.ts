/** Download bookkeeping only. Never add source URLs or request headers here. */
export type DownloadState = "queued" | "downloading" | "completed" | "skipped" | "failed";

export interface DownloadRecord {
  mediaId: string;
  filename: string;
  state: DownloadState;
  chromeDownloadId?: number;
  error?: string;
  updatedAt: number;
}

export type DownloadIndex = Record<string, DownloadRecord>;

const DOWNLOAD_INDEX_KEY = "fansly-mymedia:download-index";
const MAX_RECORDS = 100_000;
let writeQueue: Promise<void> = Promise.resolve();

export async function loadDownloadIndex(): Promise<DownloadIndex> {
  const stored = await chrome.storage.local.get(DOWNLOAD_INDEX_KEY);
  return parseDownloadIndex(stored[DOWNLOAD_INDEX_KEY]);
}

export async function getDownloadRecord(mediaId: string): Promise<DownloadRecord | null> {
  return (await loadDownloadIndex())[mediaId] ?? null;
}

export async function upsertDownloadRecord(record: DownloadRecord): Promise<void> {
  const valid = parseDownloadRecord(record);
  if (!valid) throw new Error("Refusing to persist an invalid download record.");
  await updateDownloadIndex((index) => ({
    ...index,
    [valid.mediaId]: valid
  }));
}

export async function updateDownloadByChromeId(
  chromeDownloadId: number,
  update: (record: DownloadRecord) => DownloadRecord
): Promise<DownloadRecord | null> {
  if (!Number.isInteger(chromeDownloadId) || chromeDownloadId < 0) return null;
  let updatedRecord: DownloadRecord | null = null;
  await updateDownloadIndex((index) => {
    const key = Object.keys(index).find(
      (mediaId) => index[mediaId]?.chromeDownloadId === chromeDownloadId
    );
    if (!key) return index;
    const current = index[key];
    if (!current) return index;
    const next = parseDownloadRecord(update(current));
    if (!next) throw new Error("Refusing to persist an invalid download update.");
    updatedRecord = next;
    return { ...index, [key]: next };
  });
  return updatedRecord;
}

export async function clearDownloadIndex(): Promise<void> {
  await enqueueWrite(() => chrome.storage.local.remove(DOWNLOAD_INDEX_KEY));
}

async function updateDownloadIndex(
  update: (index: DownloadIndex) => DownloadIndex
): Promise<void> {
  await enqueueWrite(async () => {
    const index = await loadDownloadIndex();
    await chrome.storage.local.set({ [DOWNLOAD_INDEX_KEY]: update(index) });
  });
}

async function enqueueWrite(write: () => Promise<void>): Promise<void> {
  const pending = writeQueue.then(write, write);
  writeQueue = pending.catch(() => undefined);
  await pending;
}

function parseDownloadIndex(value: unknown): DownloadIndex {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > MAX_RECORDS) return {};
  return Object.fromEntries(entries.flatMap(([key, record]) => {
    const valid = parseDownloadRecord(record);
    return valid && key === valid.mediaId ? [[key, valid]] : [];
  }));
}

function parseDownloadRecord(value: unknown): DownloadRecord | null {
  if (!isRecord(value) || !isSafeId(value.mediaId) || !isSafeFilename(value.filename) || !isState(value.state)
    || !isFiniteTimestamp(value.updatedAt)) return null;
  const chromeDownloadId = value.chromeDownloadId;
  if (chromeDownloadId !== undefined && (typeof chromeDownloadId !== "number" || !Number.isInteger(chromeDownloadId) || chromeDownloadId < 0)) return null;
  if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 500)) return null;
  return {
    mediaId: value.mediaId,
    filename: value.filename,
    state: value.state,
    ...(chromeDownloadId === undefined ? {} : { chromeDownloadId }),
    ...(value.error === undefined ? {} : { error: value.error }),
    updatedAt: value.updatedAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isSafeFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\\\r\n]/.test(value);
}

function isState(value: unknown): value is DownloadState {
  return value === "queued" || value === "downloading" || value === "completed" || value === "skipped" || value === "failed";
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
