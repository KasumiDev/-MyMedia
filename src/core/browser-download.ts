export const BROWSER_DOWNLOAD_JOB_PREFIX = "fansly-mymedia:browser-job:";
export const BROWSER_DOWNLOAD_QUEUE_PREFIX = "fansly-mymedia:browser-queued:";
export const BROWSER_DOWNLOAD_PROCESSOR_KEY = "fansly-mymedia:browser-processor";
export const BROWSER_DOWNLOAD_REVISION_KEY = "fansly-mymedia:browser-download-revision";

export type BrowserDownloadKind = "direct" | "hls";

export interface BrowserDownloadJob {
  kind: BrowserDownloadKind;
  mediaId: string;
  accountMediaId: string;
  sourceGroupId: string;
  sourceUrl: string;
  outputFilename: string;
  historyFilename: string;
  originalFilename: string;
  createdAt: number;
  likeCount: number;
  price: number;
  debug: boolean;
}

export function browserDownloadJobKey(mediaId: string): string {
  return `${BROWSER_DOWNLOAD_JOB_PREFIX}${mediaId}`;
}

export function browserDownloadQueueKey(mediaId: string): string {
  return `${BROWSER_DOWNLOAD_QUEUE_PREFIX}${mediaId}`;
}
