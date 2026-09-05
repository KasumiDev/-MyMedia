export type CollectionSource = "chat" | "liked" | "purchased";

export type ChatMediaDirection = "sent" | "received" | "all";

export interface MediaGroupingInput {
  source: CollectionSource;
  ownerAccountId: string;
  creatorName?: string | null;
  viewerAccountId?: string;
  chatName?: string;
  mediaBundleId?: string | null;
}

export function includesChatMedia(
  ownerAccountId: string,
  viewerAccountId: string,
  direction: ChatMediaDirection
): boolean {
  if (direction === "all") return true;
  if (!ownerAccountId || !viewerAccountId) return false;
  const isSent = ownerAccountId === viewerAccountId;
  return direction === "sent" ? isSent : !isSent;
}

export function mediaGroupingPath(input: MediaGroupingInput): string[] {
  if (input.source === "chat") {
    return input.ownerAccountId === input.viewerAccountId
      ? ["MyMedia"]
      : ["Received", input.chatName || "Unknown Chat"];
  }

  const creator = input.creatorName
    || (input.ownerAccountId
      ? `Creator-${input.ownerAccountId}`
      : "Unknown Creator");
  if (input.source === "liked") return ["Liked", creator];
  return input.mediaBundleId
    ? ["Purchased", creator, `Album-${input.mediaBundleId}`]
    : ["Purchased", creator];
}
