export const BRIDGE_COMMAND = "fansly-mymedia:command";
export const BRIDGE_RESULT = "fansly-mymedia:result";

export type BridgeOperation = "account" | "groups" | "media";

export interface BridgeCommand {
  type: typeof BRIDGE_COMMAND;
  requestId: string;
  operation: BridgeOperation;
  groupId?: string;
}

export interface BridgeResult {
  type: typeof BRIDGE_RESULT;
  requestId: string;
  operation: BridgeOperation;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export const isValidGroupId = (value: unknown): value is string =>
  typeof value === "string" && /^\d{6,30}$/.test(value);
