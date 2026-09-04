export const LIKES_ALBUM_TYPE = 2002;
export const PURCHASES_ALBUM_TYPE = 2007;

export interface CollectionAlbum {
  id: string;
  title: string;
  type: typeof LIKES_ALBUM_TYPE | typeof PURCHASES_ALBUM_TYPE;
  itemCount: number;
}

export function selectCollectionAlbums(values: unknown[]): CollectionAlbum[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const album = value as Record<string, unknown>;
    const id = String(album.id ?? "");
    const type = album.type;
    if (!/^\d{6,30}$/u.test(id)
      || (type !== LIKES_ALBUM_TYPE && type !== PURCHASES_ALBUM_TYPE)) return [];
    return [{
      id,
      title: typeof album.title === "string" ? album.title : "Album",
      type,
      itemCount: typeof album.itemCount === "number"
        && Number.isInteger(album.itemCount) && album.itemCount >= 0
        ? album.itemCount
        : 0
    }];
  });
}
