<script setup lang="ts">
import { ref } from "vue";
import { paginateGroups, paginateMedia, RepeatedCursorError } from "../core/pagination";

const BRIDGE_COMMAND = "fansly-mymedia:command";
const BRIDGE_RESULT = "fansly-mymedia:result";
type Operation = "account" | "groups" | "media";
type Group = { groupId: string; partnerUsername: string };
type DirectVideo = { url: string; filename: string; width: number; height: number };
type Manifest = { url: string; filename: string; width: number; height: number };
type Result = { type: typeof BRIDGE_RESULT; requestId: string; operation: Operation; ok: boolean; payload?: unknown; error?: string };

const status = ref("Ready. Run the checks in order.");
const chatId = ref("");
const selectedGroup = ref("");
const groups = ref<Group[]>([]);
const manualUrl = ref("");
const directVideo = ref<DirectVideo | null>(null);
const dashManifest = ref<Manifest | null>(null);
const hlsManifest = ref<Manifest | null>(null);
let activeJob: AbortController | null = null;

window.addEventListener("fansly-mymedia:retry", (event: Event) => {
  const detail = (event as CustomEvent<{ reason?: string; attempt?: number; retryAt?: number }>).detail;
  if (!detail?.reason || typeof detail.retryAt !== "number") return;
  status.value = `Retrying after ${detail.reason} (attempt ${detail.attempt ?? 0}) at ${new Date(detail.retryAt).toLocaleTimeString()}.`;
});

const validGroupId = (value: string) => /^\d{6,30}$/.test(value);

async function account(): Promise<void> {
  const result = await command("account");
  if (result.ok) status.value = `Authenticated account ID: ${(result.payload as { accountId: string }).accountId}`;
}

async function loadGroups(): Promise<void> {
  const result = await command("groups");
  if (!result.ok) return;
  const payload = result.payload as { count: number; groups: Group[] };
  groups.value = payload.groups;
  status.value = `Loaded one groups page: ${payload.count} groups. Choose a group or paste a chat ID.`;
}

async function loadAllGroups(): Promise<void> {
  activeJob?.abort();
  const controller = new AbortController();
  activeJob = controller;
  status.value = "Loading chat groups sequentially…";
  try {
    const all = await paginateGroups(async (offset) => {
      const result = await command("groups", undefined, offset);
      if (!result.ok) throw new Error(result.error ?? "Groups request failed.");
      return { groups: (result.payload as { groups: Group[] }).groups };
    }, { pageSize: 30, signal: controller.signal, onPage: (page, offset) => { status.value = `Loaded ${page.groups.length} groups at offset ${offset}.`; } });
    groups.value = all;
    status.value = `Finished groups pagination: ${all.length} chats discovered.`;
  } catch (error) { status.value = controller.signal.aborted ? "Groups pagination cancelled." : error instanceof Error ? error.message : "Groups pagination failed."; }
  finally { if (activeJob === controller) activeJob = null; }
}

function chooseGroup(): void {
  if (selectedGroup.value) chatId.value = selectedGroup.value;
}

async function media(): Promise<void> {
  if (!validGroupId(chatId.value.trim())) {
    status.value = "Enter a valid numeric chat ID first.";
    return;
  }
  const result = await command("media", chatId.value.trim());
  if (!result.ok) return;
  const payload = result.payload as { offerCount: number; accountMediaCount: number; directVideo: DirectVideo | null; dashManifest: Manifest | null; hlsManifest: Manifest | null };
  directVideo.value = payload.directVideo;
  dashManifest.value = payload.dashManifest;
  hlsManifest.value = payload.hlsManifest;
  status.value = `First MyMedia page for ${chatId.value}:\nOffers: ${payload.offerCount}\nAccount media: ${payload.accountMediaCount}${directVideo.value ? `\nHighest direct video selected: ${directVideo.value.width}×${directVideo.value.height}` : "\nNo direct video found."}${dashManifest.value ? `\nDASH manifest available: ${dashManifest.value.width}×${dashManifest.value.height}` : "\nNo DASH manifest found."}${hlsManifest.value ? `\nHLS manifest available: ${hlsManifest.value.width}×${hlsManifest.value.height}` : "\nNo HLS manifest found."}`;
}

async function allMedia(): Promise<void> {
  if (!validGroupId(chatId.value.trim())) { status.value = "Enter a valid numeric chat ID first."; return; }
  activeJob?.abort();
  const controller = new AbortController();
  activeJob = controller;
  try {
    const pages = await paginateMedia(async (before) => {
      const result = await command("media", chatId.value.trim(), undefined, before);
      if (!result.ok) throw new Error(result.error ?? "MyMedia request failed.");
      const payload = result.payload as { offers: { id: string }[]; accountMediaCount: number };
      return { offers: payload.offers, accountMediaCount: payload.accountMediaCount };
    }, { signal: controller.signal, onPage: (page, before) => { status.value = `Fetched ${page.offers.length} offers (cursor: ${before || "start"}).`; } });
    status.value = `Finished MyMedia pagination: ${pages.length} pages, ${pages.reduce((total, page) => total + page.offers.length, 0)} offers.`;
  } catch (error) { status.value = controller.signal.aborted ? "MyMedia pagination cancelled." : error instanceof RepeatedCursorError ? error.message : error instanceof Error ? error.message : "MyMedia pagination failed."; }
  finally { if (activeJob === controller) activeJob = null; }
}

function cancel(): void { activeJob?.abort(); }

async function download(url: string, filename?: string, success = "Download started. Check Chrome’s downloads page."): Promise<void> {
  status.value = "Asking Chrome to start the download…";
  const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:download", url, filename }) as { ok: boolean; error?: string };
  status.value = result.ok ? success : result.error ?? "Download failed.";
}

async function command(operation: Operation, groupId?: string, offset?: number, before?: string): Promise<Result> {
  const requestId = crypto.randomUUID();
  status.value = "Requesting Fansly…";
  const result = await new Promise<Result>((resolve) => {
    const timer = window.setTimeout(() => finish({ type: BRIDGE_RESULT, requestId, operation, ok: false, error: "The page bridge timed out." }), 20_000);
    function finish(value: Result): void { window.clearTimeout(timer); window.removeEventListener(BRIDGE_RESULT, listener); resolve(value); }
    function listener(event: Event): void {
      const value = (event as CustomEvent<unknown>).detail as Partial<Result>;
      if (value?.requestId === requestId && value.operation === operation && typeof value.ok === "boolean") finish(value as Result);
    }
    window.addEventListener(BRIDGE_RESULT, listener);
    window.dispatchEvent(new CustomEvent(BRIDGE_COMMAND, { detail: { type: BRIDGE_COMMAND, requestId, operation, ...(groupId ? { groupId } : {}), ...(offset !== undefined ? { offset } : {}), ...(before !== undefined ? { before } : {}) } }));
  });
  if (!result.ok) status.value = result.error ?? "Request failed.";
  return result;
}
</script>

<template>
  <section class="fansly-mymedia-panel">
    <h1>MyMedia feasibility spike</h1>
    <button @click="account">Check signed-in account</button>
    <button @click="loadGroups">Load one chat-groups page</button>
    <button @click="loadAllGroups">Load all chat groups</button>
    <label>Chat ID<input v-model="chatId" inputmode="numeric" placeholder="Select a group or paste a chat ID"></label>
    <select v-model="selectedGroup" @change="chooseGroup"><option value="">Loaded groups appear here</option><option v-for="group in groups" :key="group.groupId" :value="group.groupId">{{ group.partnerUsername || "Unknown" }} ({{ group.groupId }})</option></select>
    <button @click="media">Check first MyMedia page</button>
    <button @click="allMedia">Check all MyMedia pages</button>
    <button @click="cancel">Cancel active pagination</button>
    <button :disabled="!directVideo" @click="directVideo && download(directVideo.url, directVideo.filename, 'Direct video download started. Check Chrome’s downloads page.')">Download highest-quality direct video</button>
    <button :disabled="!dashManifest" @click="dashManifest && download(dashManifest.url, dashManifest.filename, 'DASH manifest downloaded. This test does not assemble media segments.')">Download DASH manifest (test only)</button>
    <button :disabled="!hlsManifest" @click="hlsManifest && download(hlsManifest.url, hlsManifest.filename, 'HLS manifest downloaded. This test does not assemble media segments.')">Download HLS manifest (test only)</button>
    <label>Signed media URL<input v-model="manualUrl" type="password" placeholder="Paste a signed media URL" autocomplete="off"></label>
    <button @click="download(manualUrl)">Download this URL once</button>
    <p class="note">This spike does not retain credentials, signed URLs, or download history.</p>
    <output>{{ status }}</output>
  </section>
</template>
