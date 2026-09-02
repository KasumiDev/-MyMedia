const DATABASE_NAME = "fansly-mymedia-directory";
const DATABASE_VERSION = 1;
const STORE_NAME = "settings";
const HANDLE_KEY = "download-directory";

export async function loadDownloadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const database = await openDatabase();
  try {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(HANDLE_KEY);
    return await requestResult<FileSystemDirectoryHandle | undefined>(request) ?? null;
  } finally {
    database.close();
  }
}

export async function saveDownloadDirectoryHandle(
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const database = await openDatabase();
  try {
    await requestResult(
      database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(
        handle,
        HANDLE_KEY
      )
    );
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Could not open download-directory storage.")
    );
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("Download-directory storage failed.")
    );
  });
}
