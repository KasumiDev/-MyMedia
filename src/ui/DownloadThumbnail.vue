<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  mediaId: string;
  kind: "Image" | "Video" | "Media";
}>();

const container = ref<HTMLElement | null>(null);
const source = ref<string | null>(null);
let observer: IntersectionObserver | null = null;
let retryTimer: number | null = null;

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer?.disconnect();
    void loadThumbnail();
  }, { rootMargin: "150px" });

  if (container.value) observer.observe(container.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (retryTimer !== null) window.clearTimeout(retryTimer);
});

async function loadThumbnail(attempt = 0): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "fansly-mymedia:get-thumbnail",
    mediaId: props.mediaId
  }) as { ok?: boolean; dataUrl?: string | null };

  if (response.ok && response.dataUrl) {
    source.value = response.dataUrl;
  } else if (attempt < 15) {
    retryTimer = window.setTimeout(() => void loadThumbnail(attempt + 1), 1_000);
  }
}
</script>

<template>
  <div
    ref="container"
    class="
      grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg
      bg-emerald-500/10 text-xs font-semibold text-emerald-300
    "
  >
    <img
      v-if="source"
      class="size-full object-cover"
      :src="source"
      width="50"
      height="50"
      alt=""
    >
    <span v-else>{{ kind }}</span>
  </div>
</template>
