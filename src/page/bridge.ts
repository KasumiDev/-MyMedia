import { delay, isEmptySuggestion, MAX_EMPTY_SUGGESTION_RETRIES, MAX_RATE_LIMIT_RETRIES, NORMAL_DELAY_MS, randomDelay, RATE_LIMIT_DELAY_MS } from "../core/retry-policy";
import { selectDiagnosticManifest, selectDownloadableMedia } from "../core/media-parser";

const BRIDGE_COMMAND = "fansly-mymedia:command";
export {};
const BRIDGE_RESULT = "fansly-mymedia:result";
type BridgeOperation = "account" | "groups" | "media";
interface BridgeCommand { type: typeof BRIDGE_COMMAND; requestId: string; operation: BridgeOperation; groupId?: string; offset?: number; before?: string; }
const isValidGroupId = (value: unknown): value is string => typeof value === "string" && /^\d{6,30}$/.test(value);

declare global {
  interface Window { __fanslyMyMediaBridgeInstalled?: boolean; }
}

export function installBridge(): void {
  if (window.__fanslyMyMediaBridgeInstalled) return;
  window.__fanslyMyMediaBridgeInstalled = true;
  installSessionHeaderCapture();

  window.addEventListener(BRIDGE_COMMAND, (event: Event) => {
    const command = (event as CustomEvent<unknown>).detail;
    if (!isCommand(command)) return;
    void run(command);
  });
}

let lastRequestAt = 0;
const sessionHeaders = new Headers();
const SESSION_HEADER_NAMES = new Set([
  "authorization",
  "fansly-client-id",
  "fansly-client-ts",
  "fansly-session-id",
  "fansly-client-check"
]);

function isCommand(value: unknown): value is BridgeCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BridgeCommand>;
  if (candidate.type !== BRIDGE_COMMAND || typeof candidate.requestId !== "string") return false;
  if (!["account", "groups", "media"].includes(candidate.operation ?? "")) return false;
  if (candidate.operation === "media" && !isValidGroupId(candidate.groupId)) return false;
  if (candidate.offset !== undefined && (!Number.isInteger(candidate.offset) || candidate.offset < 0 || candidate.offset > 1_000_000)) return false;
  return candidate.before === undefined || (typeof candidate.before === "string" && /^\d{0,30}$/.test(candidate.before));
}

async function run(command: BridgeCommand): Promise<void> {
  try {
    const payload = await request(command.operation, command.groupId, command.offset ?? 0, command.before ?? "");
    emit({ type: BRIDGE_RESULT, requestId: command.requestId, operation: command.operation, ok: true, payload });
  } catch (error) {
    // Deliberately return no response body, headers, URL query values, or credentials.
    emit({ type: BRIDGE_RESULT, requestId: command.requestId, operation: command.operation, ok: false, error: error instanceof Error ? error.message : "Request failed" });
  }
}

async function request(operation: BridgeOperation, groupId?: string, offset = 0, before = ""): Promise<unknown> {
  const wait = Math.max(0, randomDelay(NORMAL_DELAY_MS) - (Date.now() - lastRequestAt));
  if (wait) await delay(wait);
  lastRequestAt = Date.now();
  const url = new URL(operation === "account"
    ? "https://apiv3.fansly.com/api/v1/account/me"
    : operation === "groups"
      ? "https://apiv3.fansly.com/api/v1/messaging/groups"
      : "https://apiv3.fansly.com/api/v1/mediaoffers/location");

  url.searchParams.set("ngsw-bypass", "true");
  if (operation === "groups") {
    Object.entries({ sortOrder: "1", flags: "0", subscriptionTierId: "", listIds: "", search: "", limit: "30", offset: String(offset) })
      .forEach(([key, value]) => url.searchParams.set(key, value));
  }
  if (operation === "media") {
    Object.entries({ locationId: groupId!, locationType: "4001", accountId: await accountId(), mediaType: "", before, after: "0", limit: "30", offset: "0" })
      .forEach(([key, value]) => url.searchParams.set(key, value));
  }

  if (!sessionHeaders.has("authorization")) {
    throw new Error("Fansly session data is not available yet. Reload the Fansly page, wait for it to finish loading, then try again.");
  }
  return sanitize(operation, await fetchJsonWithRetry(url, operation === "media"));
}

async function fetchJsonWithRetry(url: URL, retryEmptySuggestion: boolean): Promise<unknown> {
  let rateLimitRetries = 0;
  let emptyRetries = 0;
  for (;;) {
    const response = await fetch(url, { credentials: "include", headers: sessionHeaders });
    if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      rateLimitRetries += 1;
      const wait = randomDelay(RATE_LIMIT_DELAY_MS);
      emitRetry("rate-limit", rateLimitRetries, wait);
      await delay(wait);
      continue;
    }
    if (!response.ok) throw new Error(response.status === 400
      ? "Fansly rejected the current session request. Reload the Fansly page and try again."
      : `Fansly request failed (${response.status})`);
    const json: unknown = await response.json();
    if (retryEmptySuggestion && isEmptySuggestion(json)) {
      if (emptyRetries >= MAX_EMPTY_SUGGESTION_RETRIES) {
        throw new Error("MyMedia response remained inconclusive after retries.");
      }
      emptyRetries += 1;
      const wait = randomDelay(NORMAL_DELAY_MS);
      emitRetry("empty-suggestion", emptyRetries, wait);
      await delay(wait);
      continue;
    }
    return json;
  }
}

function emitRetry(reason: "rate-limit" | "empty-suggestion", attempt: number, waitMs: number): void {
  window.dispatchEvent(new CustomEvent("fansly-mymedia:retry", { detail: { reason, attempt, retryAt: Date.now() + waitMs } }));
}

async function accountId(): Promise<string> {
  if (!sessionHeaders.has("authorization")) {
    throw new Error("Fansly session data is not available yet. Reload the Fansly page, wait for it to finish loading, then try again.");
  }
  const json = await fetchJsonWithRetry(new URL("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true"), false);
  const id = (json as { response?: { account?: { id?: unknown } } }).response?.account?.id;
  if (typeof id !== "string" && typeof id !== "number") throw new Error("Authenticated account ID was missing");
  return String(id);
}

function sanitize(operation: BridgeOperation, json: unknown): unknown {
  const response = (json as { response?: unknown })?.response;
  if (operation === "account") {
    const id = (response as { account?: { id?: unknown } })?.account?.id;
    if (typeof id !== "string" && typeof id !== "number") throw new Error("Authenticated account ID was missing");
    return { accountId: String(id) };
  }
  if (operation === "groups") {
    const groups = requiredArray(response, ["groups", "data"], "Chat groups response was malformed");
    return { count: groups.length, groups: groups.slice(0, 30).map(groupSummary).filter(Boolean) };
  }
  const mediaResponse = response as { data?: unknown; aggregationData?: { accountMedia?: unknown } };
  const data = requiredArray(mediaResponse, ["data"], "MyMedia response was malformed");
  const media = requiredArray(mediaResponse?.aggregationData, ["accountMedia"], "MyMedia aggregation response was malformed");
  const downloadableMedia = selectDownloadableMedia(media);
  const video = downloadableMedia.filter((item) => item.kind === "video")[0] ?? null;
  const dashManifest = selectDiagnosticManifest(media, "application/dash+xml");
  const hlsManifest = selectDiagnosticManifest(media, "application/vnd.apple.mpegurl");
  return {
    offerCount: data.length,
    offers: data.map(offerSummary).filter((offer): offer is { id: string } => offer !== null),
    accountMediaCount: media.length,
    // The signed URL is transferred only in-memory to immediately request a
    // Chrome download. It is never rendered, logged, or persisted.
    downloadableMedia,
    // Compatibility for the Phase 1 panel. Phase 5 consumes
    // downloadableMedia and creates filenames with the chat partner name.
    directVideo: video ? { ...video, filename: `Fansly MyMedia/${video.accountMediaId}-direct.${video.extension}` } : null,
    dashManifest: dashManifest ? { ...dashManifest, filename: `Fansly MyMedia/${dashManifest.accountMediaId}.mpd` } : null,
    hlsManifest: hlsManifest ? { ...hlsManifest, filename: `Fansly MyMedia/${hlsManifest.accountMediaId}.m3u8` } : null
  };
}

function requiredArray(response: unknown, keys: string[], message: string): unknown[] {
  const record = response as Record<string, unknown> | undefined;
  for (const key of keys) if (Array.isArray(record?.[key])) return record[key];
  throw new Error(message);
}

function offerSummary(value: unknown): { id: string } | null {
  const id = (value as { id?: unknown })?.id;
  return typeof id === "string" || typeof id === "number" ? { id: String(id) } : null;
}

function groupSummary(value: unknown): { groupId: string; partnerUsername: string } | null {
  const group = value as { groupId?: unknown; partnerUsername?: unknown };
  return isValidGroupId(String(group?.groupId ?? ""))
    ? { groupId: String(group.groupId), partnerUsername: typeof group.partnerUsername === "string" ? group.partnerUsername : "" }
    : null;
}

function emit(result: unknown): void {
  window.dispatchEvent(new CustomEvent(BRIDGE_RESULT, { detail: result }));
}

/**
 * Fansly generates short-lived request headers in its own page runtime. Observe
 * only its API requests and retain only the small allowlist in this MAIN-world
 * closure. The content script, service worker, UI, storage, and bridge results
 * never receive these values.
 */
function installSessionHeaderCapture(): void {
  const nativeFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    captureHeaders(urlFromFetchInput(input), headersFromFetchInput(input, init));
    return nativeFetch.call(this, input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: [boolean?, string?, string?]): void {
    (this as XMLHttpRequest & { __fanslyMyMediaUrl?: string }).__fanslyMyMediaUrl = new URL(String(url), location.href).toString();
    nativeOpen.call(this, method, url, rest[0] ?? true, rest[1], rest[2]);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string): void {
    const url = (this as XMLHttpRequest & { __fanslyMyMediaUrl?: string }).__fanslyMyMediaUrl;
    if (url) captureHeaders(url, new Headers([[name, value]]));
    nativeSetRequestHeader.call(this, name, value);
  };
}

function urlFromFetchInput(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function headersFromFetchInput(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}

function captureHeaders(url: string, headers: Headers): void {
  try {
    if (new URL(url, location.href).hostname !== "apiv3.fansly.com") return;
    headers.forEach((value, name) => {
      if (SESSION_HEADER_NAMES.has(name.toLowerCase())) sessionHeaders.set(name, value);
    });
  } catch { /* Ignore malformed page requests. */ }
}
