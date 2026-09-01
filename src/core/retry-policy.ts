export const NORMAL_DELAY_MS = { min: 1_000, max: 5_000 };
export const RATE_LIMIT_DELAY_MS = { min: 60_000, max: 120_000 };
export const MAX_RATE_LIMIT_RETRIES = 5;
export const MAX_EMPTY_SUGGESTION_RETRIES = 4;

export const randomDelay = (range: { min: number; max: number }, random = Math.random): number =>
  Math.floor(range.min + random() * (range.max - range.min + 1));

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Operation aborted", "AbortError")); }, { once: true });
  });
}

export const isEmptySuggestion = (value: unknown): boolean => {
  const response = (value as { response?: { mediaOfferSuggestions?: unknown; data?: unknown; aggregationData?: unknown } })?.response;
  return Array.isArray(response?.mediaOfferSuggestions) && response.mediaOfferSuggestions.length === 0 && response.data === undefined && response.aggregationData === undefined;
};
