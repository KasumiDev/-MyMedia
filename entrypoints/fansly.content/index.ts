import {
  parseRelayRequest,
  type BridgeRelayResult
} from "../../src/core/relay-protocol";

export default defineContentScript({
  matches: ["https://fansly.com/*"],
  runAt: "document_idle",
  main() {
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      const request = parseRelayRequest(message);
      if (!request || sender.id !== chrome.runtime.id) return;
      void relayToPage(request)
        .then(sendResponse)
        .catch((error: unknown) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Fansly request failed."
        } satisfies BridgeRelayResult));
      return true;
    });
  }
});

async function relayToPage(
  request: NonNullable<ReturnType<typeof parseRelayRequest>>
): Promise<BridgeRelayResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(
      () => finish({ ok: false, error: "Fansly request timed out." }),
      15 * 60 * 1_000
    );

    function listener(event: Event): void {
      const value = (event as CustomEvent<{
        requestId?: string;
        ok?: boolean;
        payload?: unknown;
        error?: string;
      }>).detail;
      if (value?.requestId !== requestId) return;
      finish({
        ok: value.ok === true,
        payload: value.payload,
        error: value.error
      });
    }

    function finish(result: BridgeRelayResult): void {
      window.clearTimeout(timeout);
      window.removeEventListener("fansly-mymedia:result", listener);
      resolve(result);
    }

    window.addEventListener("fansly-mymedia:result", listener);
    window.dispatchEvent(new CustomEvent("fansly-mymedia:command", {
      detail: {
        type: "fansly-mymedia:command",
        requestId,
        operation: request.operation,
        ...(request.groupId ? { groupId: request.groupId } : {}),
        ...(request.accountId ? { accountId: request.accountId } : {}),
        ...(request.albumId ? { albumId: request.albumId } : {}),
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.before === undefined ? {} : { before: request.before })
      }
    }));
  });
}
