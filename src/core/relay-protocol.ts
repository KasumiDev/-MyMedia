export const BRIDGE_RELAY_REQUEST = "fansly-mymedia:relay-command";

export type BridgeRelayOperation = "groups" | "media";

export interface BridgeRelayRequest {
  type: typeof BRIDGE_RELAY_REQUEST;
  operation: BridgeRelayOperation;
  groupId?: string;
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
    || (request.operation !== "groups" && request.operation !== "media")) return null;
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
  return typeof request.groupId === "string" && /^\d{6,30}$/u.test(request.groupId)
    && typeof request.before === "string" && /^\d{0,30}$/u.test(request.before)
    ? {
        type: BRIDGE_RELAY_REQUEST,
        operation: "media",
        groupId: request.groupId,
        before: request.before
      }
    : null;
}
