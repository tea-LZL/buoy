import { getFeed, listFeeds, replaceEntries, saveEntries, updateFeed } from "./database";
import { parseImport } from "./feed-parser";
import type { CacheRebuildSummary, Feed, RefreshResult } from "../types";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const REFRESH_CONCURRENCY = 3;

interface RefreshOptions {
  force?: boolean;
  replaceCache?: boolean;
}

export async function refreshFeed(feedId: string, options: RefreshOptions = {}): Promise<RefreshResult> {
  const feed = await getFeed(feedId);
  if (!feed) throw new Error("Feed not found.");
  const hadPreviousFetch = Boolean(feed.lastFetchedAt);
  if (!feed.url) return { feed, addedEntries: [], unchanged: true, hadPreviousFetch };

  try {
    const response = await fetchFeed(feed, options.force);
    const fetchedAt = Date.now();
    if (response.status === 304) {
      return {
        feed: await updateFeed(feed.id, { lastFetchedAt: fetchedAt, lastError: undefined }),
        addedEntries: [],
        unchanged: true,
        hadPreviousFetch
      };
    }
    if (!response.ok) throw new Error(`Request failed (${response.status}).`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_FEED_BYTES) throw new Error("Feed is larger than 10 MB.");

    const parsed = parseImport(await response.text(), response.url || feed.url);
    if (parsed.kind !== "feed") throw new Error("This URL returned OPML, not a feed.");
    const addedEntries = options.replaceCache
      ? await replaceEntries(feed.id, parsed.feed.entries)
      : await saveEntries(feed.id, parsed.feed.entries);
    const updated = await updateFeed(feed.id, {
      title: parsed.feed.title || feed.title,
      url: response.url || feed.url,
      siteUrl: parsed.feed.siteUrl || feed.siteUrl,
      iconUrl: parsed.feed.iconUrl || feed.iconUrl,
      description: parsed.feed.description || feed.description,
      etag: response.headers.get("etag") || undefined,
      lastModified: response.headers.get("last-modified") || undefined,
      lastFetchedAt: fetchedAt,
      lastError: undefined,
      isLocal: false
    });
    return { feed: updated, addedEntries, unchanged: false, hadPreviousFetch };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not refresh this feed.";
    const updated = await updateFeed(feed.id, { lastError: message.slice(0, 240) });
    return { feed: updated, addedEntries: [], unchanged: false, hadPreviousFetch };
  }
}

export async function refreshAll(): Promise<RefreshResult[]> {
  return refreshFeeds((await listFeeds()).filter((feed) => feed.url));
}

export async function rebuildCache(): Promise<CacheRebuildSummary> {
  const results = await refreshFeeds((await listFeeds()).filter((feed) => feed.url), {
    force: true,
    replaceCache: true
  });
  const failed = results.filter((result) => Boolean(result.feed.lastError)).length;
  return { refreshed: results.length - failed, failed };
}

async function refreshFeeds(feeds: Feed[], options: RefreshOptions = {}): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, feeds.length) }, async () => {
    while (index < feeds.length) {
      const feed = feeds[index++];
      results.push(await refreshFeed(feed.id, options));
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchFeed(feed: Feed, force = false): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = new Headers({ Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml" });
    if (!force && feed.etag) headers.set("If-None-Match", feed.etag);
    if (!force && feed.lastModified) headers.set("If-Modified-Since", feed.lastModified);
    return await fetch(feed.url!, {
      headers,
      cache: force ? "no-store" : "default",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
