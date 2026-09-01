/**
 * Persistent, sanitized resume point for the current collection job.
 *
 * Authentication material and signed URLs deliberately have no place in this
 * schema.  The page bridge recreates those transient values after a resume.
 */
export interface JobSettings {
  chatLimit: number | null;
  minDelaySeconds: number;
  maxDelaySeconds: number;
}

export type PersistedJobStatus = "running" | "paused" | "stopped" | "interrupted";

export interface FailedDownloadRecord {
  mediaId: string;
  filename: string;
  error: string;
  failedAt: number;
}

export interface PersistedJob {
  version: 1;
  jobId: string;
  status: PersistedJobStatus;
  settings: JobSettings;
  completedChatIds: string[];
  currentChatId?: string;
  currentCursor?: string;
  failedDownloads: FailedDownloadRecord[];
  createdAt: number;
  updatedAt: number;
}

const ACTIVE_JOB_KEY = "fansly-mymedia:active-job";
const MAX_CHAT_IDS = 100_000;
const MAX_FAILED_DOWNLOADS = 10_000;

export async function loadActiveJob(): Promise<PersistedJob | null> {
  const stored = await chrome.storage.local.get(ACTIVE_JOB_KEY);
  return parsePersistedJob(stored[ACTIVE_JOB_KEY]);
}

export async function saveActiveJob(job: PersistedJob): Promise<void> {
  const sanitized = parsePersistedJob(job);
  if (!sanitized) throw new Error("Refusing to persist an invalid job checkpoint.");
  await chrome.storage.local.set({ [ACTIVE_JOB_KEY]: sanitized });
}

export async function updateActiveJob(
  update: (current: PersistedJob | null) => PersistedJob | null
): Promise<PersistedJob | null> {
  const next = update(await loadActiveJob());
  if (next === null) {
    await clearActiveJob();
    return null;
  }
  const withTimestamp = { ...next, updatedAt: Date.now() };
  await saveActiveJob(withTimestamp);
  return withTimestamp;
}

export async function clearActiveJob(): Promise<void> {
  await chrome.storage.local.remove(ACTIVE_JOB_KEY);
}

function parsePersistedJob(value: unknown): PersistedJob | null {
  if (!isRecord(value) || value.version !== 1 || !isSafeId(value.jobId) || !isJobStatus(value.status)) return null;
  if (!isSettings(value.settings) || !isFiniteTimestamp(value.createdAt) || !isFiniteTimestamp(value.updatedAt)) return null;
  if (!Array.isArray(value.completedChatIds) || value.completedChatIds.length > MAX_CHAT_IDS) return null;
  if (!value.completedChatIds.every(isSafeId)) return null;
  if (value.currentChatId !== undefined && !isSafeId(value.currentChatId)) return null;
  if (value.currentCursor !== undefined && !isSafeId(value.currentCursor)) return null;
  if (!Array.isArray(value.failedDownloads) || value.failedDownloads.length > MAX_FAILED_DOWNLOADS) return null;
  if (!value.failedDownloads.every(isFailedDownload)) return null;

  return {
    version: 1,
    jobId: value.jobId,
    status: value.status,
    settings: { ...value.settings },
    completedChatIds: [...new Set(value.completedChatIds)],
    ...(value.currentChatId ? { currentChatId: value.currentChatId } : {}),
    ...(value.currentCursor ? { currentCursor: value.currentCursor } : {}),
    failedDownloads: value.failedDownloads.map((record) => ({ ...record })),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function isSettings(value: unknown): value is JobSettings {
  const chatLimit = isRecord(value) ? value.chatLimit : undefined;
  return isRecord(value)
    && (chatLimit === null || (typeof chatLimit === "number" && Number.isInteger(chatLimit) && chatLimit > 0 && chatLimit <= MAX_CHAT_IDS))
    && isDelay(value.minDelaySeconds)
    && isDelay(value.maxDelaySeconds)
    && value.minDelaySeconds <= value.maxDelaySeconds;
}

function isFailedDownload(value: unknown): value is FailedDownloadRecord {
  return isRecord(value)
    && isSafeId(value.mediaId)
    && isSafeFilename(value.filename)
    && typeof value.error === "string" && value.error.length <= 500
    && isFiniteTimestamp(value.failedAt);
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

function isJobStatus(value: unknown): value is PersistedJobStatus {
  return value === "running" || value === "paused" || value === "stopped" || value === "interrupted";
}

function isDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 300;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
