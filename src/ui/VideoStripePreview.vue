<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  previewUrl: string | null;
  stripeUrl: string | null;
  frameWidth: number;
  frameHeight: number;
  active: boolean;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const isAnimating = ref(false);
let stripeImage: HTMLImageElement | null = null;
let loadPromise: Promise<HTMLImageElement> | null = null;
let intervalId: number | null = null;
let frameIndex = 0;

onBeforeUnmount(stopAnimation);

watch(
  () => props.active,
  (active) => active ? void startAnimation() : stopAnimation(),
  { immediate: true }
);

async function startAnimation(): Promise<void> {
  if (!hasUsableStripe() || intervalId !== null) return;
  const image = await loadStripe();
  if (!image || !props.active) return;

  isAnimating.value = true;
  frameIndex = 0;
  drawFrame(image);
  intervalId = window.setInterval(() => {
    frameIndex += 1;
    drawFrame(image);
  }, 300);
}

function stopAnimation(): void {
  if (intervalId !== null) window.clearInterval(intervalId);
  intervalId = null;
  isAnimating.value = false;
}

function hasUsableStripe(): boolean {
  return Boolean(props.stripeUrl) && props.frameWidth > 0 && props.frameHeight > 0;
}

async function loadStripe(): Promise<HTMLImageElement | null> {
  if (stripeImage?.complete && stripeImage.naturalWidth > 0) return stripeImage;
  if (!props.stripeUrl) return null;
  loadPromise ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      stripeImage = image;
      resolve(image);
    };
    image.onerror = () => reject(new Error("The video preview stripe could not be loaded."));
    image.src = props.stripeUrl ?? "";
  });

  try {
    return await loadPromise;
  } catch {
    return null;
  }
}

function drawFrame(image: HTMLImageElement): void {
  const target = canvas.value;
  if (!target) return;
  const columns = Math.floor(image.naturalWidth / props.frameWidth);
  const rows = Math.floor(image.naturalHeight / props.frameHeight);
  const frameCount = Math.min(columns * rows, 500);
  if (columns < 1 || rows < 1 || frameCount < 1) return;

  const bounds = target.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;

  const context = target.getContext("2d");
  if (!context) return;
  const currentFrame = frameIndex % frameCount;
  const sourceX = (currentFrame % columns) * props.frameWidth;
  const sourceY = Math.floor(currentFrame / columns) * props.frameHeight;
  const scale = Math.max(width / props.frameWidth, height / props.frameHeight);
  const destinationWidth = props.frameWidth * scale;
  const destinationHeight = props.frameHeight * scale;

  context.clearRect(0, 0, width, height);
  context.drawImage(
    image,
    sourceX,
    sourceY,
    props.frameWidth,
    props.frameHeight,
    (width - destinationWidth) / 2,
    (height - destinationHeight) / 2,
    destinationWidth,
    destinationHeight
  );
}
</script>

<template>
  <div
    class="relative size-full"
    aria-hidden="true"
  >
    <img
      v-if="previewUrl"
      class="size-full object-cover"
      :src="previewUrl"
      loading="lazy"
      alt=""
    >
    <div
      v-else
      class="grid size-full place-items-center text-sm text-zinc-500"
    >
      No preview
    </div>
    <canvas
      v-show="isAnimating"
      ref="canvas"
      class="absolute inset-0 size-full"
      aria-hidden="true"
    />
  </div>
</template>
