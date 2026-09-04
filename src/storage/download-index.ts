/** Download bookkeeping only. Never add source URLs or request headers here. */
export type DownloadState = "queued" | "downloading" | "completed" | "skipped" | "failed";

export interface DownloadRecord {
  mediaId: string;
  accountMediaId?: string;
  sourceGroupId?: string;
  sourceType?: "chat" | "album";
  filename: string;
  originalFilename?: string;
  createdAt?: number;
  likeCount?: number;
  price?: number;
  state: DownloadState;
  chromeDownloadId?: number;
  error?: string;
  updatedAt: number;
}

export type DownloadIndex = Record<string, DownloadRecord>;

type StoredDownload = DownloadRecord & {
  thumbnail?: Blob;
};

const DATABASE_NAME = "fansly-mymedia";
const DATABASE_VERSION = 1;
const STORE_NAME = "downloads";
const CHROME_ID_INDEX = "chrome-download-id";
const LEGACY_STORAGE_KEY = "fansly-mymedia:download-index";
const MAX_RECORDS = 100_000;
let writeQueue: Promise<void> = Promise.resolve();

export async function loadDownloadIndex(): Promise<DownloadIndex> {
  const records = await readAllDownloads();
  return Object.fromEntries(records.slice(0, MAX_RECORDS).map((record) => [
    record.mediaId,
    publicRecord(record)
  ]));
}

export async function getDownloadRecord(mediaId: string): Promise<DownloadRecord | null> {
  const record = await readDownload(mediaId);
  return record ? publicRecord(record) : null;
}

export async function upsertDownloadRecord(record: DownloadRecord): Promise<void> {
  const valid = parseDownloadRecord(record);
  if (!valid) throw new Error("Refusing to persist an invalid download record.");

  await enqueueWrite(async () => {
    const current = await readDownload(valid.mediaId);
    await putDownload({
      ...(current?.thumbnail ? { thumbnail: current.thumbnail } : {}),
      ...valid
    });
  });
}

export async function updateDownloadByChromeId(
  chromeDownloadId: number,
  update: (record: DownloadRecord) => DownloadRecord
): Promise<DownloadRecord | null> {
  if (!Number.isInteger(chromeDownloadId) || chromeDownloadId < 0) return null;

  let updated: DownloadRecord | null = null;
  await enqueueWrite(async () => {
    const current = await readDownloadByChromeId(chromeDownloadId);
    if (!current) return;
    const valid = parseDownloadRecord(update(publicRecord(current)));
    if (!valid) throw new Error("Refusing to persist an invalid download update.");
    await putDownload({ ...current, ...valid });
    updated = valid;
  });
  return updated;
}

export async function updateDownloadByMediaId(
  mediaId: string,
  update: (record: DownloadRecord) => DownloadRecord
): Promise<DownloadRecord | null> {
  if (!isSafeId(mediaId)) {
    return null;
  }

  let updated: DownloadRecord | null = null;
  await enqueueWrite(async () => {
    const current = await readDownload(mediaId);
    if (!current) {
      return;
    }

    const valid = parseDownloadRecord(update(publicRecord(current)));
    if (!valid) {
      throw new Error("Refusing to persist an invalid download update.");
    }

    await putDownload({ ...current, ...valid });
    updated = valid;
  });
  return updated;
}

export async function storeDownloadThumbnail(mediaId: string, thumbnail: Blob): Promise<void> {
  if (!isSafeId(mediaId) || !thumbnail.type.startsWith("image/") || thumbnail.size > 50_000) {
    throw new Error("Refusing to persist an invalid download thumbnail.");
  }

  await enqueueWrite(async () => {
    const current = await readDownload(mediaId);
    if (!current) throw new Error("The download record does not exist.");
    await putDownload({ ...current, thumbnail });
  });
}

export async function loadDownloadThumbnailDataUrl(mediaId: string): Promise<string | null> {
  if (!isSafeId(mediaId)) return null;
  const thumbnail = (await readDownload(mediaId))?.thumbnail;
  return thumbnail ? blobToDataUrl(thumbnail) : null;
}

export async function migrateLegacyDownloadIndex(): Promise<void> {
  const stored = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
  const records = Object.values(parseDownloadIndex(stored[LEGACY_STORAGE_KEY]));
  if (records.length > 0) {
    await enqueueWrite(async () => {
      for (const record of records) {
        const current = await readDownload(record.mediaId);
        if (!current) await putDownload(record);
      }
    });
  }
  await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
}

export async function clearDownloadIndex(): Promise<void> {
  await enqueueWrite(async () => {
    const database = await openDatabase();
    try {
      await requestResult(
        database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear()
      );
    } finally {
      database.close();
    }
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "mediaId" });
      if (store && !store.indexNames.contains(CHROME_ID_INDEX)) {
        store.createIndex(CHROME_ID_INDEX, "chromeDownloadId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Could not open download storage.")
    );
  });
}

async function readAllDownloads(): Promise<StoredDownload[]> {
  const database = await openDatabase();
  try {
    return await requestResult(
      database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()
    );
  } finally {
    database.close();
  }
}

async function readDownload(mediaId: string): Promise<StoredDownload | null> {
  const database = await openDatabase();
  try {
    const record = await requestResult<StoredDownload | undefined>(
      database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(mediaId)
    );
    return record ?? null;
  } finally {
    database.close();
  }
}

async function readDownloadByChromeId(chromeDownloadId: number): Promise<StoredDownload | null> {
  const database = await openDatabase();
  try {
    const record = await requestResult<StoredDownload | undefined>(
      database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .index(CHROME_ID_INDEX)
        .get(chromeDownloadId)
    );
    return record ?? null;
  } finally {
    database.close();
  }
}

async function putDownload(record: StoredDownload): Promise<void> {
  const database = await openDatabase();
  try {
    await requestResult(
      database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record)
    );
  } finally {
    database.close();
  }
}

async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Download storage failed."));
  });
}

async function enqueueWrite(write: () => Promise<void>): Promise<void> {
  const pending = writeQueue.then(write, write);
  writeQueue = pending.catch(() => undefined);
  await pending;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function publicRecord(record: StoredDownload): DownloadRecord {
  return {
    mediaId: record.mediaId,
    ...(record.accountMediaId === undefined
      ? {}
      : { accountMediaId: record.accountMediaId }),
    ...(record.sourceGroupId === undefined
      ? {}
      : { sourceGroupId: record.sourceGroupId }),
    ...(record.sourceType === undefined ? {} : { sourceType: record.sourceType }),
    filename: record.filename,
    ...(record.originalFilename === undefined
      ? {}
      : { originalFilename: record.originalFilename }),
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    ...(record.likeCount === undefined ? {} : { likeCount: record.likeCount }),
    ...(record.price === undefined ? {} : { price: record.price }),
    state: record.state,
    ...(record.chromeDownloadId === undefined
      ? {}
      : { chromeDownloadId: record.chromeDownloadId }),
    ...(record.error === undefined ? {} : { error: record.error }),
    updatedAt: record.updatedAt
  };
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
  if (!isRecord(value) || !isSafeId(value.mediaId) || !isSafeFilename(value.filename)
    || !isState(value.state) || !isFiniteTimestamp(value.updatedAt)) return null;
  if (value.originalFilename !== undefined && !isSafeOriginalFilename(value.originalFilename)) {
    return null;
  }
  if (value.accountMediaId !== undefined && !isSafeId(value.accountMediaId)) return null;
  if (value.sourceGroupId !== undefined && !isSafeGroupId(value.sourceGroupId)) return null;
  if (value.sourceType !== undefined
    && value.sourceType !== "chat" && value.sourceType !== "album") return null;
  if (value.createdAt !== undefined && !isFiniteTimestamp(value.createdAt)) return null;
  if (value.likeCount !== undefined && !isNonNegativeInteger(value.likeCount)) return null;
  if (value.price !== undefined && !isNonNegativeInteger(value.price)) return null;
  const chromeDownloadId = value.chromeDownloadId;
  if (chromeDownloadId !== undefined && (typeof chromeDownloadId !== "number"
    || !Number.isInteger(chromeDownloadId) || chromeDownloadId < 0)) return null;
  if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 500)) {
    return null;
  }
  return {
    mediaId: value.mediaId,
    ...(value.accountMediaId === undefined
      ? {}
      : { accountMediaId: value.accountMediaId }),
    ...(value.sourceGroupId === undefined
      ? {}
      : { sourceGroupId: value.sourceGroupId }),
    ...(value.sourceType === undefined ? {} : { sourceType: value.sourceType }),
    filename: value.filename,
    ...(value.originalFilename === undefined
      ? {}
      : { originalFilename: value.originalFilename }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.likeCount === undefined ? {} : { likeCount: value.likeCount }),
    ...(value.price === undefined ? {} : { price: value.price }),
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

function isSafeGroupId(value: unknown): value is string {
  return typeof value === "string" && /^\d{6,30}$/u.test(value);
}

function isSafeFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && !/[\\\r\n]/.test(value);
}

function isSafeOriginalFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 180
    && !/[\\/\r\n]/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isState(value: unknown): value is DownloadState {
  return value === "queued" || value === "downloading" || value === "completed"
    || value === "skipped" || value === "failed";
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
