<script setup lang="ts">
import { ref } from "vue";

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

async function download(url: string, filename?: string, success = "Download started. Check Chrome’s downloads page."): Promise<void> {
  status.value = "Asking Chrome to start the download…";
  const result = await chrome.runtime.sendMessage({ type: "fansly-mymedia:download", url, filename }) as { ok: boolean; error?: string };
  status.value = result.ok ? success : result.error ?? "Download failed.";
}

async function command(operation: Operation, groupId?: string): Promise<Result> {
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
    window.dispatchEvent(new CustomEvent(BRIDGE_COMMAND, { detail: { type: BRIDGE_COMMAND, requestId, operation, ...(groupId ? { groupId } : {}) } }));
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
    <label>Chat ID<input v-model="chatId" inputmode="numeric" placeholder="Select a group or paste a chat ID"></label>
    <select v-model="selectedGroup" @change="chooseGroup"><option value="">Loaded groups appear here</option><option v-for="group in groups" :key="group.groupId" :value="group.groupId">{{ group.partnerUsername || "Unknown" }} ({{ group.groupId }})</option></select>
    <button @click="media">Check first MyMedia page</button>
    <button :disabled="!directVideo" @click="directVideo && download(directVideo.url, directVideo.filename, 'Direct video download started. Check Chrome’s downloads page.')">Download highest-quality direct video</button>
    <button :disabled="!dashManifest" @click="dashManifest && download(dashManifest.url, dashManifest.filename, 'DASH manifest downloaded. This test does not assemble media segments.')">Download DASH manifest (test only)</button>
    <button :disabled="!hlsManifest" @click="hlsManifest && download(hlsManifest.url, hlsManifest.filename, 'HLS manifest downloaded. This test does not assemble media segments.')">Download HLS manifest (test only)</button>
    <label>Signed media URL<input v-model="manualUrl" type="password" placeholder="Paste a signed media URL" autocomplete="off"></label>
    <button @click="download(manualUrl)">Download this URL once</button>
    <p class="note">This spike does not retain credentials, signed URLs, or download history.</p>
    <output>{{ status }}</output>
  </section>
</template>
