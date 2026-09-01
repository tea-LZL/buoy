export interface Feed {
  id: string;
  title: string;
  url?: string;
  siteUrl?: string;
  iconUrl?: string;
  description?: string;
  etag?: string;
  lastModified?: string;
  lastFetchedAt?: number;
  lastError?: string;
  notify: boolean;
  isLocal: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Entry {
  id: string;
  feedId: string;
  externalId: string;
  title: string;
  url?: string;
  author?: string;
  content: string;
  imageUrl?: string;
  publishedAt: number;
  read: boolean;
  createdAt: number;
}

export interface ParsedEntry {
  externalId: string;
  title: string;
  url?: string;
  author?: string;
  content: string;
  imageUrl?: string;
  publishedAt: number;
}

export interface ParsedFeed {
  title: string;
  siteUrl?: string;
  selfUrl?: string;
  iconUrl?: string;
  description?: string;
  entries: ParsedEntry[];
}

export interface OpmlSubscription {
  title?: string;
  url: string;
  siteUrl?: string;
}

export type ParsedImport =
  | { kind: "feed"; feed: ParsedFeed }
  | { kind: "opml"; subscriptions: OpmlSubscription[] };

export interface EntryPage {
  entries: Entry[];
  hasMore: boolean;
}

export interface EntryCursor {
  publishedAt: number;
  id: string;
}

export interface RefreshResult {
  feed: Feed;
  addedEntries: Entry[];
  unchanged: boolean;
  hadPreviousFetch: boolean;
}

export interface CacheRebuildSummary {
  refreshed: number;
  failed: number;
}
