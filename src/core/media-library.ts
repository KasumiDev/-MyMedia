export type IdentifiedMedia = {
  mediaId: string;
};

/**
 * Adds newly discovered media while preserving the first occurrence of each
 * underlying Fansly media record.
 */
export function mergeUniqueMedia<T extends IdentifiedMedia>(
  existing: T[],
  incoming: T[]
): T[] {
  const knownMediaIds = new Set<string>();
  const merged: T[] = [];

  for (const item of [...existing, ...incoming]) {
    if (knownMediaIds.has(item.mediaId)) continue;
    knownMediaIds.add(item.mediaId);
    merged.push(item);
  }

  return merged;
}
