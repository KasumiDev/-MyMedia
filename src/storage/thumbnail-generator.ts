import { storeDownloadThumbnail } from "./download-index";

const THUMBNAIL_SIZE = 50;

export async function createAndStoreThumbnail(
  mediaId: string,
  sourceUrl: URL
): Promise<void> {
  const response = await fetch(sourceUrl, { credentials: "omit" });
  if (!response.ok) throw new Error("Could not fetch the media preview.");

  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a thumbnail canvas.");

    const scale = Math.max(
      THUMBNAIL_SIZE / bitmap.width,
      THUMBNAIL_SIZE / bitmap.height
    );
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (THUMBNAIL_SIZE - width) / 2,
      (THUMBNAIL_SIZE - height) / 2,
      width,
      height
    );

    const thumbnail = await canvas.convertToBlob({
      type: "image/webp",
      quality: 0.65
    });
    await storeDownloadThumbnail(mediaId, thumbnail);
  } finally {
    bitmap.close();
  }
}
