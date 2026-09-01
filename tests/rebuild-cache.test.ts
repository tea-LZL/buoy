import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeed, getEntry, listFeeds, saveEntries, setEntryRead, updateFeed } from "../src/lib/database";
import { rebuildCache, refreshFeed } from "../src/lib/feed-service";

const rss = (items: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><link>https://feed.example/</link>${items}</channel></rss>`;

const item = (guid: string, title: string) =>
  `<item><guid>${guid}</guid><title>${title}</title><pubDate>Mon, 02 Sep 2024 10:00:00 GMT</pubDate></item>`;

function mockFetch(status: number, body: string, headers: Record<string, string> = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => new Response(body, { status, headers })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rebuildCache", () => {
  it("forces fresh network requests without conditional headers", async () => {
    const { feed } = await createFeed({ title: "Forced", url: "https://forced.example/feed.xml" });
    await updateFeed(feed.id, {
      etag: "\"abc\"",
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT"
    });

    const fetchMock = mockFetch(200, rss(item("a", "A")));
    await refreshFeed(feed.id, { force: true, replaceCache: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("https://forced.example/feed.xml");
    const headers = new Headers(init.headers);
    expect(headers.has("If-None-Match")).toBe(false);
    expect(headers.has("If-Modified-Since")).toBe(false);
    expect(init.cache).toBe("no-store");
  });

  it("keeps conditional headers on normal refresh", async () => {
    const { feed } = await createFeed({ title: "Conditional", url: "https://conditional.example/feed.xml" });
    await updateFeed(feed.id, { etag: "\"abc\"", lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" });

    const fetchMock = mockFetch(304, "");
    await refreshFeed(feed.id);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("If-None-Match")).toBe("\"abc\"");
    expect(headers.get("If-Modified-Since")).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
    expect(init.cache).toBe("default");
  });

  it("removes stale entries while preserving read state and creation time", async () => {
    const { feed } = await createFeed({ title: "Rebuild", url: "https://rebuild.example/feed.xml" });
    const added = await saveEntries(feed.id, [
      { externalId: "keep", title: "Keep", content: "old content", publishedAt: 3 },
      { externalId: "stale", title: "Stale", content: "old content", publishedAt: 2 }
    ]);
    const keep = added.find((entry) => entry.externalId === "keep")!;
    const stale = added.find((entry) => entry.externalId === "stale")!;
    await setEntryRead(keep.id, true);

    mockFetch(200, rss(item("keep", "Keep v2")));
    const result = await refreshFeed(feed.id, { force: true, replaceCache: true });

    expect(result.addedEntries).toEqual([]);
    await expect(getEntry(stale.id)).resolves.toBeUndefined();
    const kept = await getEntry(keep.id);
    expect(kept).toMatchObject({ externalId: "keep", title: "Keep v2", read: true });
    expect(kept?.createdAt).toBe(keep.createdAt);
  });

  it("keeps cached entries when the network request fails", async () => {
    const { feed } = await createFeed({ title: "Fail", url: "https://fail.example/feed.xml" });
    const [entry] = await saveEntries(feed.id, [{ externalId: "one", title: "One", content: "", publishedAt: 1 }]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    const result = await refreshFeed(feed.id, { force: true, replaceCache: true });

    expect(result.feed.lastError).toBe("network down");
    await expect(getEntry(entry.id)).resolves.toBeDefined();
  });

  it("rebuilds only remote feeds and reports success", async () => {
    const baselineRemote = (await listFeeds()).filter((feed) => feed.url).length;
    await createFeed({ title: "Remote", url: "https://remote.example/feed.xml" });
    await createFeed({ title: "Local snapshot", isLocal: true });

    const fetchMock = mockFetch(200, rss(item("a", "A")));
    const summary = await rebuildCache();

    expect(summary).toEqual({ refreshed: baselineRemote + 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(baselineRemote + 1);
  });

  it("counts failed rebuilds without touching their cached entries", async () => {
    const baselineRemote = (await listFeeds()).filter((feed) => feed.url).length;
    const { feed } = await createFeed({ title: "Remote", url: "https://remote-fail.example/feed.xml" });
    const [entry] = await saveEntries(feed.id, [{ externalId: "one", title: "One", content: "", publishedAt: 1 }]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("down");
    }));

    const summary = await rebuildCache();

    expect(summary).toEqual({ refreshed: 0, failed: baselineRemote + 1 });
    await expect(getEntry(entry.id)).resolves.toBeDefined();
    const feeds = await listFeeds();
    expect(feeds.find((item) => item.url === "https://remote-fail.example/feed.xml")?.lastError).toBe("down");
  });
});
