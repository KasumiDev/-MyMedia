import type { ChatGroup, MediaPage } from "./models";

export class RepeatedCursorError extends Error {
  constructor(cursor: string) {
    super(`Media pagination stopped because cursor ${cursor} repeated.`);
    this.name = "RepeatedCursorError";
  }
}

export interface GroupsPage { groups: ChatGroup[]; }

export async function paginateGroups(
  fetchPage: (offset: number, signal: AbortSignal) => Promise<GroupsPage>,
  options: { pageSize: number; signal: AbortSignal; onPage?: (page: GroupsPage, offset: number) => void }
): Promise<ChatGroup[]> {
  const groups: ChatGroup[] = [];
  for (let offset = 0; ; offset += options.pageSize) {
    throwIfAborted(options.signal);
    const page = await fetchPage(offset, options.signal);
    throwIfAborted(options.signal);
    options.onPage?.(page, offset);
    groups.push(...page.groups);
    if (page.groups.length === 0) return groups;
  }
}

export async function paginateMedia(
  fetchPage: (before: string, signal: AbortSignal) => Promise<MediaPage>,
  options: { signal: AbortSignal; onPage?: (page: MediaPage, before: string) => void }
): Promise<MediaPage[]> {
  const pages: MediaPage[] = [];
  const visited = new Set<string>();
  let before = "";
  for (;;) {
    throwIfAborted(options.signal);
    const page = await fetchPage(before, options.signal);
    throwIfAborted(options.signal);
    options.onPage?.(page, before);
    pages.push(page);
    if (page.offers.length === 0) return pages;
    const next = page.offers.at(-1)?.id;
    if (!next) return pages;
    if (visited.has(next)) throw new RepeatedCursorError(next);
    visited.add(next);
    before = next;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
}
