export interface ChatGroup {
  groupId: string;
  partnerUsername: string;
}

export interface MediaOffer {
  id: string;
}

export interface MediaPage {
  offers: MediaOffer[];
  accountMediaCount: number;
  downloadableMedia?: unknown[];
}

export interface DiagnosticEvent {
  kind: "groups-page" | "media-page" | "malformed-response" | "cancelled";
  timestamp: number;
  offset?: number;
  cursor?: string;
  count?: number;
  message?: string;
}
