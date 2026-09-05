export const BRIDGE_RELAY_REQUEST = "fansly-mymedia:relay-command";

export type BridgeRelayOperation = "groups" | "media" | "albums" | "albumMedia";

export interface BridgeRelayRequest {
  type: typeof BRIDGE_RELAY_REQUEST;
  operation: BridgeRelayOperation;
  groupId?: string;
  accountId?: string;
  albumId?: string;
  offset?: number;
  before?: string;
}

export interface BridgeRelayResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export function parseRelayRequest(value: unknown): BridgeRelayRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<BridgeRelayRequest>;
  if (request.type !== BRIDGE_RELAY_REQUEST
    || !["groups", "media", "albums", "albumMedia"].includes(
      request.operation ?? ""
    )) return null;
  if (request.operation === "albums") {
    return {
      type: BRIDGE_RELAY_REQUEST,
      operation: "albums"
    };
  }
  if (request.operation === "groups") {
    return Number.isInteger(request.offset) && Number(request.offset) >= 0
      && Number(request.offset) <= 1_000_000
      ? {
          type: BRIDGE_RELAY_REQUEST,
          operation: "groups",
          offset: Number(request.offset)
        }
      : null;
  }
  const locationId = request.operation === "media" ? request.groupId : request.albumId;
  if (typeof locationId !== "string" || !/^\d{6,30}$/u.test(locationId)
    || typeof request.before !== "string" || !/^\d{0,30}$/u.test(request.before)) {
    return null;
  }
  if (request.operation === "media" && request.accountId !== undefined
    && (typeof request.accountId !== "string"
      || !/^\d{6,30}$/u.test(request.accountId))) {
    return null;
  }
  return request.operation === "media"
    ? {
        type: BRIDGE_RELAY_REQUEST,
        operation: "media",
        groupId: locationId,
        ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
        before: request.before
      }
    : {
        type: BRIDGE_RELAY_REQUEST,
        operation: "albumMedia",
        albumId: locationId,
        before: request.before
      };
}
