import { getFeed, listFeeds, saveEntries, updateFeed } from "./database";
import { parseImport } from "./feed-parser";
import type { Feed, RefreshResult } from "../types";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const REFRESH_CONCURRENCY = 3;

export async function refreshFeed(feedId: string): Promise<RefreshResult> {
  const feed = await getFeed(feedId);
  if (!feed) throw new Error("Feed not found.");
  const hadPreviousFetch = Boolean(feed.lastFetchedAt);
  if (!feed.url) return { feed, addedEntries: [], unchanged: true, hadPreviousFetch };

  try {
    const response = await fetchFeed(feed);
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
    const addedEntries = await saveEntries(feed.id, parsed.feed.entries);
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
  const feeds = (await listFeeds()).filter((feed) => feed.url);
  const results: RefreshResult[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, feeds.length) }, async () => {
    while (index < feeds.length) {
      const feed = feeds[index++];
      results.push(await refreshFeed(feed.id));
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchFeed(feed: Feed): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = new Headers({ Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml" });
    if (feed.etag) headers.set("If-None-Match", feed.etag);
    if (feed.lastModified) headers.set("If-Modified-Since", feed.lastModified);
    return await fetch(feed.url!, {
      headers,
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
