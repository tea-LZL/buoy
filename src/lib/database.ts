import type { Entry, EntryCursor, EntryPage, Feed, ParsedEntry } from "../types";

const DATABASE_NAME = "buoy";
const DATABASE_VERSION = 1;
const MAX_ENTRIES_PER_FEED = 200;
const MAX_TIME = 8_640_000_000_000_000;

let databasePromise: Promise<IDBDatabase> | undefined;

export async function listFeeds(): Promise<Feed[]> {
  const database = await openDatabase();
  const transaction = database.transaction("feeds", "readonly");
  const feeds = await request<Feed[]>(transaction.objectStore("feeds").getAll());
  await complete(transaction);
  return feeds.sort((left, right) => left.title.localeCompare(right.title));
}

export async function getFeed(id: string): Promise<Feed | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction("feeds", "readonly");
  const feed = await request<Feed | undefined>(transaction.objectStore("feeds").get(id));
  await complete(transaction);
  return feed;
}

export async function createFeed(input: {
  title: string;
  url?: string;
  siteUrl?: string;
  iconUrl?: string;
  description?: string;
  isLocal?: boolean;
}): Promise<{ feed: Feed; created: boolean }> {
  if (input.url) {
    const existing = await getFeedByUrl(input.url);
    if (existing) return { feed: existing, created: false };
  }

  const now = Date.now();
  const feed: Feed = {
    id: crypto.randomUUID(),
    title: input.title || "Untitled feed",
    url: input.url,
    siteUrl: input.siteUrl,
    iconUrl: input.iconUrl,
    description: input.description,
    notify: false,
    isLocal: input.isLocal ?? !input.url,
    createdAt: now,
    updatedAt: now
  };
  await putFeed(feed);
  return { feed, created: true };
}

export async function updateFeed(id: string, patch: Partial<Omit<Feed, "id" | "createdAt">>): Promise<Feed> {
  const current = await getFeed(id);
  if (!current) throw new Error("Feed not found.");
  const feed = { ...current, ...patch, updatedAt: Date.now() };
  await putFeed(feed);
  return feed;
}

export async function removeFeed(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(["feeds", "entries"], "readwrite");
  transaction.objectStore("feeds").delete(id);
  const entryStore = transaction.objectStore("entries");
  const index = entryStore.index("byFeedPublishedKey");
  const range = IDBKeyRange.bound([id, 0, ""], [id, MAX_TIME, "\uffff"]);
  await deleteCursor(index.openCursor(range), entryStore);
  await complete(transaction);
}

export async function saveEntries(feedId: string, parsedEntries: ParsedEntry[]): Promise<Entry[]> {
  const database = await openDatabase();
  const transaction = database.transaction("entries", "readwrite");
  const store = transaction.objectStore("entries");
  const added: Entry[] = [];

  for (const parsed of parsedEntries) {
    const id = entryKey(feedId, parsed.externalId);
    const current = await request<Entry | undefined>(store.get(id));
    const entry: Entry = {
      id,
      feedId,
      externalId: parsed.externalId,
      title: parsed.title,
      url: parsed.url,
      author: parsed.author,
      content: parsed.content,
      imageUrl: parsed.imageUrl,
      publishedAt: parsed.publishedAt,
      read: current?.read ?? false,
      createdAt: current?.createdAt ?? Date.now()
    };
    if (!current) added.push(entry);
    store.put(entry);
  }

  await complete(transaction);
  await retainLatestEntries(feedId);
  return added;
}

export async function listEntries(options: {
  feedId?: string;
  unreadOnly?: boolean;
  cursor?: EntryCursor;
  limit?: number;
} = {}): Promise<EntryPage> {
  const database = await openDatabase();
  const transaction = database.transaction("entries", "readonly");
  const store = transaction.objectStore("entries");
  const limit = options.limit ?? 60;
  const index = options.feedId ? store.index("byFeedPublishedKey") : store.index("byPublishedKey");
  const range = entryRange(options.feedId, options.cursor);
  const entries = await collectCursor<Entry>(index.openCursor(range, "prev"), limit + 1, (entry) => {
    return !options.unreadOnly || !entry.read;
  });
  await complete(transaction);
  return {
    entries: entries.slice(0, limit),
    hasMore: entries.length > limit
  };
}

export async function getEntry(id: string): Promise<Entry | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction("entries", "readonly");
  const entry = await request<Entry | undefined>(transaction.objectStore("entries").get(id));
  await complete(transaction);
  return entry;
}

export async function setEntryRead(id: string, read: boolean): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction("entries", "readwrite");
  const store = transaction.objectStore("entries");
  const entry = await request<Entry | undefined>(store.get(id));
  if (entry) store.put({ ...entry, read });
  await complete(transaction);
}

export function retainNewest<T extends { publishedAt: number; id: string }>(entries: T[], limit = MAX_ENTRIES_PER_FEED): T[] {
  return [...entries]
    .sort((left, right) => right.publishedAt - left.publishedAt || right.id.localeCompare(left.id))
    .slice(0, limit);
}

async function getFeedByUrl(url: string): Promise<Feed | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction("feeds", "readonly");
  const feed = await request<Feed | undefined>(transaction.objectStore("feeds").index("byUrl").get(url));
  await complete(transaction);
  return feed;
}

async function putFeed(feed: Feed): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction("feeds", "readwrite");
  transaction.objectStore("feeds").put(feed);
  await complete(transaction);
}

async function retainLatestEntries(feedId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction("entries", "readwrite");
  const store = transaction.objectStore("entries");
  const index = store.index("byFeedPublishedKey");
  const range = IDBKeyRange.bound([feedId, 0, ""], [feedId, MAX_TIME, "\uffff"]);
  const all = await request<Entry[]>(index.getAll(range));
  const keep = new Set(retainNewest(all).map((entry) => entry.id));
  for (const entry of all) {
    if (!keep.has(entry.id)) store.delete(entry.id);
  }
  await complete(transaction);
}

function entryRange(feedId?: string, cursor?: EntryCursor): IDBKeyRange | undefined {
  if (feedId) {
    const upper = cursor ? [feedId, cursor.publishedAt, cursor.id] : [feedId, MAX_TIME, "\uffff"];
    return IDBKeyRange.bound([feedId, 0, ""], upper, false, Boolean(cursor));
  }
  return cursor ? IDBKeyRange.upperBound([cursor.publishedAt, cursor.id], true) : undefined;
}

function entryKey(feedId: string, externalId: string): string {
  return `${feedId}:${hash(externalId)}`;
}

function hash(value: string): string {
  let result = 0xcbf29ce484222325n;
  for (const character of value) {
    result ^= BigInt(character.codePointAt(0) ?? 0);
    result = BigInt.asUintN(64, result * 0x100000001b3n);
  }
  return result.toString(16);
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      const feeds = database.createObjectStore("feeds", { keyPath: "id" });
      feeds.createIndex("byUrl", "url", { unique: true });
      const entries = database.createObjectStore("entries", { keyPath: "id" });
      entries.createIndex("byPublishedKey", ["publishedAt", "id"]);
      entries.createIndex("byFeedPublishedKey", ["feedId", "publishedAt", "id"]);
    };
    request.onsuccess = () => resolve(request.result);
  });
  return databasePromise;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Database transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Database transaction failed."));
  });
}

function collectCursor<T>(
  value: IDBRequest<IDBCursorWithValue | null>,
  limit: number,
  include: (entry: T) => boolean
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const entries: T[] = [];
    value.onerror = () => reject(value.error);
    value.onsuccess = () => {
      const cursor = value.result;
      if (!cursor || entries.length >= limit) {
        resolve(entries);
        return;
      }
      const entry = cursor.value as T;
      if (include(entry)) entries.push(entry);
      cursor.continue();
    };
  });
}

function deleteCursor(value: IDBRequest<IDBCursorWithValue | null>, store: IDBObjectStore): Promise<void> {
  return new Promise((resolve, reject) => {
    value.onerror = () => reject(value.error);
    value.onsuccess = () => {
      const cursor = value.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}
