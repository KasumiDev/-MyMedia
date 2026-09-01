const BRIDGE_COMMAND = "fansly-mymedia:command";
export {};
const BRIDGE_RESULT = "fansly-mymedia:result";
type BridgeOperation = "account" | "groups" | "media";
interface BridgeResult { type: typeof BRIDGE_RESULT; requestId: string; operation: BridgeOperation; ok: boolean; payload?: unknown; error?: string; }
const isValidGroupId = (value: unknown): value is string => typeof value === "string" && /^\d{6,30}$/.test(value);

type Group = { groupId: string; partnerUsername: string };
type DirectVideo = { url: string; filename: string; width: number; height: number };
type DashManifest = { url: string; filename: string; width: number; height: number };

const root = document.createElement("div");
root.id = "fansly-mymedia-spike";
const shadow = root.attachShadow({ mode: "closed" });
shadow.innerHTML = `
  <style>
    :host { all: initial; } #panel { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: 330px; padding: 14px; border-radius: 10px; background: #17151d; color: #f8f7fa; box-shadow: 0 8px 28px #0008; font: 13px/1.4 system-ui, sans-serif; }
    h1 { font-size: 15px; margin: 0 0 10px; } label { display: block; margin-top: 9px; } input, select, button { box-sizing: border-box; width: 100%; margin-top: 4px; padding: 7px; border-radius: 5px; border: 1px solid #615b6d; background: #28242e; color: inherit; font: inherit; } button { cursor: pointer; background: #7a4cff; border: 0; } button:hover { background: #8d67ff; } #status { white-space: pre-wrap; margin: 10px 0 0; max-height: 130px; overflow: auto; color: #d9d2e8; } .note { color: #aaa2b5; font-size: 11px; margin: 5px 0 0; }
  </style>
  <section id="panel">
    <h1>MyMedia feasibility spike</h1>
    <button id="account">Check signed-in account</button>
    <button id="groups">Load one chat-groups page</button>
    <label>Chat ID<input id="chat" inputmode="numeric" placeholder="Select a group or paste a chat ID"></label>
    <select id="groupSelect"><option value="">Loaded groups appear here</option></select>
    <button id="media">Check first MyMedia page</button>
    <button id="video" disabled>Download highest-quality direct video</button>
    <button id="dash" disabled>Download DASH manifest (test only)</button>
    <button id="hls" disabled>Download HLS manifest (test only)</button>
    <label>Signed media URL<input id="url" type="password" placeholder="Paste a signed media URL" autocomplete="off"></label>
    <button id="download">Download this URL once</button>
    <p class="note">This spike does not retain credentials, signed URLs, or download history.</p>
    <output id="status">Loading bridge…</output>
  </section>`;
document.documentElement.append(root);

const $ = <T extends HTMLElement>(selector: string) => shadow.querySelector(selector) as T;
const status = $("#status");
const chat = $("#chat") as HTMLInputElement;
const groupSelect = $("#groupSelect") as HTMLSelectElement;
let directVideo: DirectVideo | null = null;
let dashManifest: DashManifest | null = null;
let hlsManifest: DashManifest | null = null;

void ensureBridge();

$("#account").onclick = async () => {
  const result = await command("account");
  if (result.ok) setStatus(`Authenticated account ID: ${(result.payload as { accountId: string }).accountId}`);
};
$("#groups").onclick = async () => {
  const result = await command("groups");
  if (!result.ok) return;
  const payload = result.payload as { count: number; groups: Group[] };
  groupSelect.replaceChildren(new Option("Choose a loaded chat", ""));
  payload.groups.forEach((group) => groupSelect.add(new Option(`${group.partnerUsername || "Unknown"} (${group.groupId})`, group.groupId)));
  setStatus(`Loaded one groups page: ${payload.count} groups. Choose a group or paste a chat ID.`);
};
groupSelect.onchange = () => { if (groupSelect.value) chat.value = groupSelect.value; };
$("#media").onclick = async () => {
  if (!isValidGroupId(chat.value.trim())) return setStatus("Enter a valid numeric chat ID first.");
  const result = await command("media", chat.value.trim());
  if (result.ok) {
    const payload = result.payload as { offerCount: number; accountMediaCount: number; directVideo: DirectVideo | null; dashManifest: DashManifest | null; hlsManifest: DashManifest | null };
    directVideo = payload.directVideo;
    dashManifest = payload.dashManifest;
    hlsManifest = payload.hlsManifest;
    $("#video").toggleAttribute("disabled", !directVideo);
    $("#dash").toggleAttribute("disabled", !dashManifest);
    $("#hls").toggleAttribute("disabled", !hlsManifest);
    setStatus(`First MyMedia page for ${chat.value}:\nOffers: ${payload.offerCount}\nAccount media: ${payload.accountMediaCount}${directVideo ? `\nHighest direct video selected: ${directVideo.width}×${directVideo.height}` : "\nNo direct video found."}${dashManifest ? `\nDASH manifest available: ${dashManifest.width}×${dashManifest.height}` : "\nNo DASH manifest found."}${hlsManifest ? `\nHLS manifest available: ${hlsManifest.width}×${hlsManifest.height}` : "\nNo HLS manifest found."}`);
  }
};
$("#dash").onclick = async () => {
  if (!dashManifest) return;
  setStatus("Asking Chrome to download the DASH manifest…");
  const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:download", url: dashManifest.url, filename: dashManifest.filename }) as { ok: boolean; error?: string };
  setStatus(result.ok ? "DASH manifest downloaded. This test does not assemble media segments." : result.error ?? "DASH manifest download failed.");
};
$("#hls").onclick = async () => {
  if (!hlsManifest) return;
  setStatus("Asking Chrome to download the HLS manifest…");
  const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:download", url: hlsManifest.url, filename: hlsManifest.filename }) as { ok: boolean; error?: string };
  setStatus(result.ok ? "HLS manifest downloaded. This test does not assemble media segments." : result.error ?? "HLS manifest download failed.");
};
$("#video").onclick = async () => {
  if (!directVideo) return;
  setStatus("Asking Chrome to start the highest-quality direct video download…");
  const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:download", url: directVideo.url, filename: directVideo.filename }) as { ok: boolean; error?: string };
  setStatus(result.ok ? "Direct video download started. Check Chrome’s downloads page." : result.error ?? "Download failed.");
};
$("#download").onclick = async () => {
  const url = ($("#url") as HTMLInputElement).value.trim();
  setStatus("Asking Chrome to start the download…");
  const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:download", url }) as { ok: boolean; error?: string };
  setStatus(result.ok ? "Download started. Check Chrome’s downloads page." : result.error ?? "Download failed.");
};

async function ensureBridge(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:inject" }) as { ok: boolean; error?: string };
  setStatus(result.ok ? "Ready. Run the checks in order." : result.error ?? "Bridge injection failed.");
}

async function command(operation: BridgeOperation, groupId?: string): Promise<BridgeResult> {
  const requestId = crypto.randomUUID();
  setStatus("Requesting Fansly…");
  const result = await new Promise<BridgeResult>((resolve) => {
    const timer = window.setTimeout(() => finish({ type: BRIDGE_RESULT, requestId, operation, ok: false, error: "The page bridge timed out." }), 20_000);
    function finish(value: BridgeResult): void { window.clearTimeout(timer); window.removeEventListener(BRIDGE_RESULT, listener); resolve(value); }
    function listener(event: Event): void {
      const value = (event as CustomEvent<unknown>).detail as Partial<BridgeResult>;
      if (value?.requestId === requestId && value.operation === operation && typeof value.ok === "boolean") finish(value as BridgeResult);
    }
    window.addEventListener(BRIDGE_RESULT, listener);
    window.dispatchEvent(new CustomEvent(BRIDGE_COMMAND, { detail: { type: BRIDGE_COMMAND, requestId, operation, ...(groupId ? { groupId } : {}) } }));
  });
  if (!result.ok) setStatus(result.error ?? "Request failed.");
  return result;
}

function setStatus(message: string): void { status.textContent = message; }
