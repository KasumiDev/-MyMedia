import { describe, expect, it } from "vitest";

import {
  LIKES_ALBUM_TYPE,
  PURCHASES_ALBUM_TYPE,
  selectCollectionAlbums
} from "../src/core/albums";

describe("collection albums", () => {
  it("selects built-in Likes and Purchases albums by type", () => {
    expect(selectCollectionAlbums([
      {
        id: "100000000000000001",
        title: "Likes",
        type: LIKES_ALBUM_TYPE,
        itemCount: 12
      },
      {
        id: "100000000000000002",
        title: "Purchases",
        type: PURCHASES_ALBUM_TYPE,
        itemCount: 34
      },
      {
        id: "100000000000000003",
        title: "Personal Album",
        type: null,
        itemCount: 5
      }
    ])).toEqual([
      {
        id: "100000000000000001",
        title: "Likes",
        type: LIKES_ALBUM_TYPE,
        itemCount: 12
      },
      {
        id: "100000000000000002",
        title: "Purchases",
        type: PURCHASES_ALBUM_TYPE,
        itemCount: 34
      }
    ]);
  });

  it("rejects invalid identifiers and normalizes invalid counts", () => {
    expect(selectCollectionAlbums([
      { id: "../unsafe", title: "Likes", type: LIKES_ALBUM_TYPE },
      { id: "100000000000000001", title: 42, type: LIKES_ALBUM_TYPE, itemCount: -1 }
    ])).toEqual([{
      id: "100000000000000001",
      title: "Album",
      type: LIKES_ALBUM_TYPE,
      itemCount: 0
    }]);
  });
});
