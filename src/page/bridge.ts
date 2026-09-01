const BRIDGE_COMMAND = "fansly-mymedia:command";
export {};
const BRIDGE_RESULT = "fansly-mymedia:result";
type BridgeOperation = "account" | "groups" | "media";
interface BridgeCommand { type: typeof BRIDGE_COMMAND; requestId: string; operation: BridgeOperation; groupId?: string; }
const isValidGroupId = (value: unknown): value is string => typeof value === "string" && /^\d{6,30}$/.test(value);

declare global {
  interface Window { __fanslyMyMediaBridgeInstalled?: boolean; }
}

if (!window.__fanslyMyMediaBridgeInstalled) {
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
  return candidate.operation !== "media" || isValidGroupId(candidate.groupId);
}

async function run(command: BridgeCommand): Promise<void> {
  try {
    const payload = await request(command.operation, command.groupId);
    emit({ type: BRIDGE_RESULT, requestId: command.requestId, operation: command.operation, ok: true, payload });
  } catch (error) {
    // Deliberately return no response body, headers, URL query values, or credentials.
    emit({ type: BRIDGE_RESULT, requestId: command.requestId, operation: command.operation, ok: false, error: error instanceof Error ? error.message : "Request failed" });
  }
}

async function request(operation: BridgeOperation, groupId?: string): Promise<unknown> {
  // The spike keeps a modest minimum interval; Phase 3 replaces this with jittered backoff.
  const wait = Math.max(0, 1_000 - (Date.now() - lastRequestAt));
  if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  const url = new URL(operation === "account"
    ? "https://apiv3.fansly.com/api/v1/account/me"
    : operation === "groups"
      ? "https://apiv3.fansly.com/api/v1/messaging/groups"
      : "https://apiv3.fansly.com/api/v1/mediaoffers/location");

  url.searchParams.set("ngsw-bypass", "true");
  if (operation === "groups") {
    Object.entries({ sortOrder: "1", flags: "0", subscriptionTierId: "", listIds: "", search: "", limit: "30", offset: "0" })
      .forEach(([key, value]) => url.searchParams.set(key, value));
  }
  if (operation === "media") {
    Object.entries({ locationId: groupId!, locationType: "4001", accountId: await accountId(), mediaType: "", before: "", after: "0", limit: "30", offset: "0" })
      .forEach(([key, value]) => url.searchParams.set(key, value));
  }

  if (!sessionHeaders.has("authorization")) {
    throw new Error("Fansly session data is not available yet. Reload the Fansly page, wait for it to finish loading, then try again.");
  }
  const response = await fetch(url, { credentials: "include", headers: sessionHeaders });
  if (!response.ok) throw new Error(response.status === 400
    ? "Fansly rejected the current session request. Reload the Fansly page and try again."
    : `Fansly request failed (${response.status})`);
  return sanitize(operation, await response.json());
}

async function accountId(): Promise<string> {
  if (!sessionHeaders.has("authorization")) {
    throw new Error("Fansly session data is not available yet. Reload the Fansly page, wait for it to finish loading, then try again.");
  }
  const response = await fetch("https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true", { credentials: "include", headers: sessionHeaders });
  if (!response.ok) throw new Error(`Account request failed (${response.status})`);
  const json: unknown = await response.json();
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
    const groups = findArray(response, ["groups", "data"]);
    return { count: groups.length, groups: groups.slice(0, 30).map(groupSummary).filter(Boolean) };
  }
  const mediaResponse = response as { data?: unknown; aggregationData?: { accountMedia?: unknown } };
  const data = Array.isArray(mediaResponse?.data) ? mediaResponse.data : [];
  const media = Array.isArray(mediaResponse?.aggregationData?.accountMedia) ? mediaResponse.aggregationData.accountMedia : [];
  const video = selectDirectVideo(media);
  const dashManifest = selectDashManifest(media);
  const hlsManifest = selectHlsManifest(media);
  return {
    offerCount: data.length,
    accountMediaCount: media.length,
    // The signed URL is transferred only in-memory to immediately request a
    // Chrome download. It is never rendered, logged, or persisted.
    directVideo: video,
    dashManifest,
    hlsManifest
  };
}

function findArray(response: unknown, keys: string[]): unknown[] {
  const record = response as Record<string, unknown> | undefined;
  for (const key of keys) if (Array.isArray(record?.[key])) return record[key];
  return [];
}

function groupSummary(value: unknown): { groupId: string; partnerUsername: string } | null {
  const group = value as { groupId?: unknown; partnerUsername?: unknown };
  return isValidGroupId(String(group?.groupId ?? ""))
    ? { groupId: String(group.groupId), partnerUsername: typeof group.partnerUsername === "string" ? group.partnerUsername : "" }
    : null;
}

type DirectVideo = { url: string; filename: string; width: number; height: number };
type DashManifest = { url: string; filename: string; width: number; height: number };

function selectDirectVideo(accountMedia: unknown[]): DirectVideo | null {
  const candidates: DirectVideo[] = [];
  for (const accountMediaRecord of accountMedia) {
    const media = (accountMediaRecord as { media?: unknown })?.media as Record<string, unknown> | undefined;
    if (!media) continue;
    for (const rendition of [media, ...(Array.isArray(media.variants) ? media.variants : [])] as Record<string, unknown>[]) {
      const mimetype = typeof rendition.mimetype === "string" ? rendition.mimetype.toLowerCase() : "";
      const locations = Array.isArray(rendition.locations) ? rendition.locations : [];
      const url = locations.map(signedLocation).find((value): value is string => typeof value === "string");
      const width = typeof rendition.width === "number" ? rendition.width : 0;
      const height = typeof rendition.height === "number" ? rendition.height : 0;
      if (!mimetype.startsWith("video/") || !url || height <= 0) continue;
      const mediaId = typeof rendition.id === "string" || typeof rendition.id === "number" ? String(rendition.id) : "video";
      candidates.push({ url, filename: `Fansly MyMedia/${mediaId}-direct.mp4`, width, height });
    }
  }
  candidates.sort((left, right) => right.height - left.height || right.width - left.width);
  return candidates[0] ?? null;
}

function selectDashManifest(accountMedia: unknown[]): DashManifest | null {
  const candidates: DashManifest[] = [];
  for (const accountMediaRecord of accountMedia) {
    const media = (accountMediaRecord as { media?: unknown })?.media as Record<string, unknown> | undefined;
    if (!media || !Array.isArray(media.variants)) continue;
    for (const rendition of media.variants as Record<string, unknown>[]) {
      if (String(rendition.mimetype).toLowerCase() !== "application/dash+xml") continue;
      const locations = Array.isArray(rendition.locations) ? rendition.locations : [];
      const url = locations.map(signedLocation).find((value): value is string => typeof value === "string");
      if (!url) continue;
      const width = typeof rendition.width === "number" ? rendition.width : 0;
      const height = typeof rendition.height === "number" ? rendition.height : 0;
      const mediaId = typeof rendition.id === "string" || typeof rendition.id === "number" ? String(rendition.id) : "manifest";
      candidates.push({ url, filename: `Fansly MyMedia/${mediaId}.mpd`, width, height });
    }
  }
  candidates.sort((left, right) => right.height - left.height || right.width - left.width);
  return candidates[0] ?? null;
}

function selectHlsManifest(accountMedia: unknown[]): DashManifest | null {
  const candidates: DashManifest[] = [];
  for (const accountMediaRecord of accountMedia) {
    const media = (accountMediaRecord as { media?: unknown })?.media as Record<string, unknown> | undefined;
    if (!media || !Array.isArray(media.variants)) continue;
    for (const rendition of media.variants as Record<string, unknown>[]) {
      if (String(rendition.mimetype).toLowerCase() !== "application/vnd.apple.mpegurl") continue;
      const locations = Array.isArray(rendition.locations) ? rendition.locations : [];
      const url = locations.map(signedLocation).find((value): value is string => typeof value === "string");
      if (!url) continue;
      const width = typeof rendition.width === "number" ? rendition.width : 0;
      const height = typeof rendition.height === "number" ? rendition.height : 0;
      const mediaId = typeof rendition.id === "string" || typeof rendition.id === "number" ? String(rendition.id) : "manifest";
      candidates.push({ url, filename: `Fansly MyMedia/${mediaId}.m3u8`, width, height });
    }
  }
  candidates.sort((left, right) => right.height - left.height || right.width - left.width);
  return candidates[0] ?? null;
}

function signedLocation(value: unknown): string | null {
  const entry = value as { location?: unknown; metadata?: unknown };
  if (typeof entry?.location !== "string") return null;
  try {
    const url = new URL(entry.location);
    const metadata = entry.metadata as Record<string, unknown> | undefined;
    for (const key of ["Key-Pair-Id", "Signature", "Policy"]) {
      if (typeof metadata?.[key] === "string" && !url.searchParams.has(key)) url.searchParams.set(key, metadata[key]);
    }
    return url.toString();
  } catch { return null; }
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
