<script setup lang="ts">
import { computed, ref } from "vue";
import { paginateGroups, paginateMedia, RepeatedCursorError } from "../core/pagination";

const BRIDGE_COMMAND = "fansly-mymedia:command";
const BRIDGE_RESULT = "fansly-mymedia:result";
type Operation = "account" | "groups" | "media";
type Group = { groupId: string; partnerUsername: string };
type DirectVideo = { url: string; filename: string; width: number; height: number };
type Manifest = { url: string; filename: string; width: number; height: number };
type Result = { type: typeof BRIDGE_RESULT; requestId: string; operation: Operation; ok: boolean; payload?: unknown; error?: string };
type JobState = "ready" | "running" | "paused" | "stopped";

const status = ref("Ready. Start discovers chats; then select a chat to inspect media.");
const groups = ref<Group[]>([]); const chatId = ref(""); const selectedGroup = ref("");
const directVideo = ref<DirectVideo | null>(null); const dashManifest = ref<Manifest | null>(null); const hlsManifest = ref<Manifest | null>(null);
const jobState = ref<JobState>("ready"); const currentPartner = ref("—"); const currentCursor = ref("—"); const retry = ref("None");
const discoveredMedia = ref(0); const completed = ref(0); const skipped = ref(0); const failed = ref(0); const debugEnabled = ref(false);
// TODO: remove/change this initial safety limit once pagination and rate-limit behavior are verified end-to-end.
const chatLimit = ref(5); const minDelay = ref(1); const maxDelay = ref(5);
let activeJob: AbortController | null = null; let resumeJob: (() => Promise<void>) | null = null;
const running = computed(() => jobState.value === "running"); const paused = computed(() => jobState.value === "paused");
const shownGroups = computed(() => groups.value.slice(0, chatLimit.value > 0 ? chatLimit.value : groups.value.length));
const validGroupId = (value: string) => /^\d{6,30}$/.test(value);

window.addEventListener("fansly-mymedia:retry", (event: Event) => {
  const value = (event as CustomEvent<{ reason?: string; attempt?: number; retryAt?: number }>).detail;
  if (!value?.reason || typeof value.retryAt !== "number") return;
  retry.value = `${value.reason}, attempt ${value.attempt ?? 0}; ${new Date(value.retryAt).toLocaleTimeString()}`;
  status.value = `Retrying: ${retry.value}`;
});

async function start(): Promise<void> { jobState.value = "running"; await account(); if (running.value) await loadAllGroups(); }
function pause(): void { if (!activeJob) { status.value = "No active pagination job to pause."; return; } resumeJob = chatId.value.trim() ? allMedia : loadAllGroups; activeJob.abort(); jobState.value = "paused"; status.value = "Paused between requests. Resume restarts the current operation."; }
async function resume(): Promise<void> { if (!resumeJob) { status.value = "Nothing is paused."; return; } jobState.value = "running"; await resumeJob(); }
function stop(): void { activeJob?.abort(); resumeJob = null; jobState.value = "stopped"; status.value = "Stopped. No more requests will be made until Start."; }
function saveSettings(): void { minDelay.value = Math.max(0, Math.floor(minDelay.value)); maxDelay.value = Math.max(minDelay.value, Math.floor(maxDelay.value)); status.value = `Delay preference set to ${minDelay.value}–${maxDelay.value}s. Queue persistence will connect this setting in Phase 6.`; }

async function account(): Promise<void> { const result = await command("account"); if (result.ok) status.value = `Authenticated account ID: ${(result.payload as { accountId: string }).accountId}`; }
async function loadGroups(): Promise<void> { const result = await command("groups"); if (!result.ok) return; groups.value = (result.payload as { groups: Group[] }).groups; status.value = `Loaded one groups page: ${groups.value.length} chats.`; }
async function loadAllGroups(): Promise<void> {
  activeJob?.abort(); const controller = new AbortController(); activeJob = controller; jobState.value = "running"; status.value = "Loading chat groups sequentially…";
  try { groups.value = await paginateGroups(async (offset) => { const r = await command("groups", undefined, offset); if (!r.ok) throw new Error(r.error ?? "Groups request failed."); return { groups: (r.payload as { groups: Group[] }).groups }; }, { pageSize: 30, signal: controller.signal, onPage: (p, o) => status.value = `Loaded ${p.groups.length} groups at offset ${o}.` }); status.value = `Finished discovering ${groups.value.length} chats. Initial limit: ${chatLimit.value || "unlimited"}.`; }
  catch (error) { status.value = controller.signal.aborted ? "Groups pagination paused or stopped." : error instanceof Error ? error.message : "Groups pagination failed."; }
  finally { if (activeJob === controller) { activeJob = null; if (running.value) jobState.value = "ready"; } }
}
function chooseGroup(): void { if (!selectedGroup.value) return; chatId.value = selectedGroup.value; currentPartner.value = groups.value.find((g) => g.groupId === chatId.value)?.partnerUsername || "Unknown"; }
async function media(): Promise<void> {
  if (!validGroupId(chatId.value.trim())) { status.value = "Enter a valid numeric chat ID first."; return; } currentCursor.value = "start";
  const result = await command("media", chatId.value.trim()); if (!result.ok) return;
  const data = result.payload as { offerCount: number; accountMediaCount: number; directVideo: DirectVideo | null; dashManifest: Manifest | null; hlsManifest: Manifest | null };
  directVideo.value = data.directVideo; dashManifest.value = data.dashManifest; hlsManifest.value = data.hlsManifest; discoveredMedia.value += data.accountMediaCount; status.value = `First MyMedia page: ${data.offerCount} offers, ${data.accountMediaCount} media records.`;
}
async function allMedia(): Promise<void> {
  if (!validGroupId(chatId.value.trim())) { status.value = "Enter a valid numeric chat ID first."; return; } activeJob?.abort(); const controller = new AbortController(); activeJob = controller; jobState.value = "running";
  try { const pages = await paginateMedia(async (before) => { currentCursor.value = before || "start"; const r = await command("media", chatId.value.trim(), undefined, before); if (!r.ok) throw new Error(r.error ?? "MyMedia request failed."); const p = r.payload as { offers: { id: string }[]; accountMediaCount: number }; return { offers: p.offers, accountMediaCount: p.accountMediaCount }; }, { signal: controller.signal, onPage: (p, before) => { discoveredMedia.value += p.accountMediaCount; status.value = `Fetched ${p.offers.length} offers (cursor ${before || "start"}).`; } }); status.value = `Finished MyMedia pagination: ${pages.length} pages.`; }
  catch (error) { status.value = controller.signal.aborted ? "MyMedia pagination paused or stopped." : error instanceof RepeatedCursorError ? error.message : error instanceof Error ? error.message : "MyMedia pagination failed."; }
  finally { if (activeJob === controller) { activeJob = null; if (running.value) jobState.value = "ready"; } }
}
async function download(url: string, filename?: string, success = "Download started. Check Chrome’s downloads page."): Promise<void> { const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:download", url, filename }) as { ok: boolean; error?: string }; if (result.ok) completed.value++; else failed.value++; status.value = result.ok ? success : result.error ?? "Download failed."; }
function retryFailed(): void { status.value = failed.value ? "Retrying failed downloads requires persisted download records, coming with Phase 6 recovery." : "No failed downloads in this panel session."; }
async function command(operation: Operation, groupId?: string, offset?: number, before?: string): Promise<Result> {
  const requestId = crypto.randomUUID(); if (debugEnabled.value) console.debug("[MyMedia] request", operation); status.value = "Requesting Fansly…";
  const result = await new Promise<Result>((resolve) => { const timer = window.setTimeout(() => finish({ type: BRIDGE_RESULT, requestId, operation, ok: false, error: "The page bridge timed out." }), 20_000); function finish(value: Result): void { clearTimeout(timer); window.removeEventListener(BRIDGE_RESULT, listener); resolve(value); } function listener(event: Event): void { const value = (event as CustomEvent<unknown>).detail as Partial<Result>; if (value?.requestId === requestId && value.operation === operation && typeof value.ok === "boolean") finish(value as Result); } window.addEventListener(BRIDGE_RESULT, listener); window.dispatchEvent(new CustomEvent(BRIDGE_COMMAND, { detail: { type: BRIDGE_COMMAND, requestId, operation, ...(groupId ? { groupId } : {}), ...(offset !== undefined ? { offset } : {}), ...(before !== undefined ? { before } : {}) } })); });
  if (!result.ok) { failed.value++; status.value = result.error ?? "Request failed."; } return result;
}
</script>

<template>
  <section class="fansly-mymedia-panel"><header><div><p>Fansly MyMedia</p><h1>Downloader MVP</h1></div><span :class="`state ${jobState}`">{{ jobState }}</span></header>
    <div class="controls"><button class="primary" :disabled="running" @click="start">Start</button><button :disabled="!running" @click="pause">Pause</button><button :disabled="!paused" @click="resume">Resume</button><button class="stop" :disabled="!running && !paused" @click="stop">Stop</button></div>
    <div class="stats"><div><b>{{ groups.length }}</b><small>chats</small></div><div><b>{{ discoveredMedia }}</b><small>discovered</small></div><div><b>{{ completed }}</b><small>completed</small></div><div><b>{{ skipped }}</b><small>skipped</small></div><div><b>{{ failed }}</b><small>failed</small></div></div>
    <details open><summary>Queue settings</summary><div class="settings"><label>Chat limit<input v-model.number="chatLimit" type="number" min="0"></label><label>Min delay<input v-model.number="minDelay" type="number" min="0"><small>seconds</small></label><label>Max delay<input v-model.number="maxDelay" type="number" min="0"><small>seconds</small></label></div><small>Default 5 (TODO: remove/change after verification); 0 displays all discovered chats.</small><button @click="saveSettings">Save delay preferences</button></details>
    <details open><summary>Chats and media</summary><div class="controls compact"><button @click="account">Check account</button><button @click="loadGroups">One groups page</button><button @click="loadAllGroups">Discover all chats</button></div><label>Chat ID<input v-model="chatId" inputmode="numeric" placeholder="Select a chat or paste an ID"></label><select v-model="selectedGroup" @change="chooseGroup"><option value="">Loaded chats appear here</option><option v-for="group in shownGroups" :key="group.groupId" :value="group.groupId">{{ group.partnerUsername || "Unknown" }} ({{ group.groupId }})</option></select><div class="controls compact"><button @click="media">Check first MyMedia page</button><button @click="allMedia">Check all MyMedia pages</button></div></details>
    <details><summary>Download diagnostics</summary><button :disabled="!directVideo" @click="directVideo && download(directVideo.url, directVideo.filename, 'Direct video download started.')">Download highest-quality direct video</button><button :disabled="!dashManifest" @click="dashManifest && download(dashManifest.url, dashManifest.filename, 'DASH manifest downloaded; no segments assembled.')">Download DASH manifest</button><button :disabled="!hlsManifest" @click="hlsManifest && download(hlsManifest.url, hlsManifest.filename, 'HLS manifest downloaded; no segments assembled.')">Download HLS manifest</button></details>
    <div class="status"><span><b>Partner:</b> {{ currentPartner }}</span><span><b>Cursor:</b> {{ currentCursor }}</span><span><b>Retry:</b> {{ retry }}</span></div><label class="debug"><input v-model="debugEnabled" type="checkbox"> Enable redacted debug logging</label><button :disabled="failed === 0" @click="retryFailed">Retry failed downloads</button><output aria-live="polite">{{ status }}</output><p class="note">No credentials, signed URLs, or download history are displayed or persisted by this panel.</p>
  </section>
</template>

<style scoped>
.fansly-mymedia-panel{width:365px;max-height:88vh;overflow:auto;padding:16px;border:1px solid #4c3c6a;border-radius:14px;background:#17131f;color:#f7f3ff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 16px 48px #0009}.fansly-mymedia-panel *{box-sizing:border-box}header,.controls{display:flex;gap:8px;align-items:center}header{justify-content:space-between}h1,p{margin:0}h1{font-size:18px}header p{color:#bca8e8;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.state{padding:3px 8px;border-radius:999px;background:#34274c;text-transform:capitalize}.state.running{background:#155934}.state.paused{background:#6a4b09}.state.stopped{background:#722b3b}.controls{flex-wrap:wrap;margin:12px 0 9px}.controls button{flex:1}.compact button{flex:0 1 auto}button{margin-top:8px;padding:7px 9px;border:1px solid #594774;border-radius:8px;background:#2a2136;color:#fff;cursor:pointer}button:hover:not(:disabled){background:#3a2d4b}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:#d3b8ff;color:#17131f;font-weight:700}.stop{border-color:#984457}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin:12px 0}.stats div{text-align:center;padding:7px 3px;border-radius:8px;background:#231c2e}.stats b,.stats small{display:block}.stats b{font-size:16px}small,.note{color:#c0b5cc;font-size:10px}details{margin-top:10px;padding-top:10px;border-top:1px solid #3c304c}summary{font-weight:700;cursor:pointer}label{display:block;margin-top:8px}input,select{display:block;width:100%;margin-top:4px;padding:7px;border:1px solid #594774;border-radius:7px;background:#100d16;color:#fff}.settings{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.status{display:flex;flex-direction:column;gap:3px;margin:12px 0;padding:9px;border-radius:8px;background:#211a2b;word-break:break-word}.status b{color:#ceb9ed}.debug{display:flex;gap:7px;align-items:center}.debug input{width:auto;margin:0}output{display:block;white-space:pre-wrap;margin-top:12px;padding:9px;border-radius:8px;background:#110e17}.note{margin-top:9px}
</style>
