import type { LocalSegment, LocalSession } from "./types.js";

const DB_NAME = "nexus_meeting_recorder_v1";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const SEGMENTS = "segments";

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS))
        db.createObjectStore(SESSIONS, { keyPath: "recordingId" });
      if (!db.objectStoreNames.contains(SEGMENTS)) {
        const store = db.createObjectStore(SEGMENTS, {
          keyPath: ["recordingId", "sequence"],
        });
        store.createIndex("recording", "recordingId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

export const localRecorderStore = {
  async saveSession(session: LocalSession): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(SESSIONS, "readwrite");
    transaction.objectStore(SESSIONS).put(session);
    await transactionDone(transaction);
    db.close();
  },
  async sessions(): Promise<LocalSession[]> {
    const db = await openDatabase();
    const transaction = db.transaction(SESSIONS, "readonly");
    const rows = await requestValue(
      transaction.objectStore(SESSIONS).getAll() as IDBRequest<LocalSession[]>,
    );
    await transactionDone(transaction);
    db.close();
    return rows;
  },
  async removeSession(recordingId: string): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(SESSIONS, "readwrite");
    transaction.objectStore(SESSIONS).delete(recordingId);
    await transactionDone(transaction);
    db.close();
  },
  async saveSegment(segment: LocalSegment): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(SEGMENTS, "readwrite");
    transaction.objectStore(SEGMENTS).put(segment);
    await transactionDone(transaction);
    db.close();
  },
  async segments(recordingId?: string): Promise<LocalSegment[]> {
    const db = await openDatabase();
    const transaction = db.transaction(SEGMENTS, "readonly");
    const store = transaction.objectStore(SEGMENTS);
    const rows = recordingId
      ? await requestValue(
          store.index("recording").getAll(recordingId) as IDBRequest<
            LocalSegment[]
          >,
        )
      : await requestValue(store.getAll() as IDBRequest<LocalSegment[]>);
    await transactionDone(transaction);
    db.close();
    return rows.toSorted((left, right) => left.sequence - right.sequence);
  },
  async removeSegment(recordingId: string, sequence: number): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(SEGMENTS, "readwrite");
    transaction.objectStore(SEGMENTS).delete([recordingId, sequence]);
    await transactionDone(transaction);
    db.close();
  },
};

export async function localStoragePreflight(): Promise<{
  availableBytes: number | null;
  persisted: boolean | null;
}> {
  const estimate = await navigator.storage?.estimate?.();
  const availableBytes =
    estimate?.quota !== undefined && estimate.usage !== undefined
      ? Math.max(0, estimate.quota - estimate.usage)
      : null;
  const persisted = navigator.storage?.persist
    ? await navigator.storage.persist().catch(() => false)
    : null;
  return { availableBytes, persisted };
}
