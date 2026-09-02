export type MediaSortOrder =
  | "created-desc"
  | "created-asc"
  | "price-desc"
  | "price-asc"
  | "likes-desc"
  | "likes-asc";

export type SortableMedia = {
  mediaId: string;
  createdAt?: number;
  price?: number;
  likeCount?: number;
};

export function sortMedia<T extends SortableMedia>(
  items: readonly T[],
  order: MediaSortOrder
): T[] {
  const [field, direction] = order.split("-") as [
    "created" | "price" | "likes",
    "asc" | "desc"
  ];
  const key = field === "created"
    ? "createdAt"
    : field === "price"
      ? "price"
      : "likeCount";

  return [...items].sort((left, right) => {
    const leftValue = finiteValue(left[key]);
    const rightValue = finiteValue(right[key]);
    if (leftValue === null && rightValue !== null) return 1;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
      return direction === "asc" ? leftValue - rightValue : rightValue - leftValue;
    }
    return left.mediaId.localeCompare(right.mediaId);
  });
}

export function isMediaSortOrder(value: unknown): value is MediaSortOrder {
  return value === "created-desc"
    || value === "created-asc"
    || value === "price-desc"
    || value === "price-asc"
    || value === "likes-desc"
    || value === "likes-asc";
}

function finiteValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
