import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createFeed, getEntry, listEntries, markFeedRead, retainNewest, saveEntries, setEntryRead } from "../src/lib/database";
import { FeedParseError, parseImport, serializeOpml } from "../src/lib/feed-parser";

const fixture = (name: string) => readFile(resolve(import.meta.dirname, "fixtures", name), "utf8");

describe("parseImport", () => {
  it("parses RSS, resolves relative URLs, strips markup, and removes duplicate items", async () => {
    const imported = parseImport(await fixture("sample.rss"), "https://notes.example/feed.xml");

    expect(imported.kind).toBe("feed");
    if (imported.kind !== "feed") return;
    expect(imported.feed).toMatchObject({
      title: "City Notes",
      siteUrl: "https://notes.example/",
      selfUrl: "https://notes.example/feed.xml",
      iconUrl: "https://notes.example/images/channel-icon.png"
    });
    expect(imported.feed.entries).toHaveLength(1);
    expect(imported.feed.entries[0]).toMatchObject({
      externalId: "notes-001",
      title: "First light",
      url: "https://notes.example/first-light",
      imageUrl: "https://notes.example/images/first.jpg"
    });
    expect(imported.feed.entries[0].content).toBe("Hello friends.bad()");
  });

  it("parses Atom metadata and entries", async () => {
    const imported = parseImport(await fixture("sample.atom"), "https://field.example/atom.xml");

    expect(imported.kind).toBe("feed");
    if (imported.kind !== "feed") return;
    expect(imported.feed).toMatchObject({
      title: "Signal Field",
      siteUrl: "https://field.example/",
      selfUrl: "https://field.example/atom.xml",
      iconUrl: "https://field.example/icon.png",
      description: "Tools and thinking."
    });
    expect(imported.feed.entries[0]).toMatchObject({
      externalId: "tag:field.example,2026:alpha",
      title: "Alpha release",
      url: "https://field.example/alpha",
      author: "Ada Lovelace",
      content: "A concise summary."
    });
  });

  it("uses RSS channel thumbnails when no channel image is present", () => {
    const imported = parseImport(`<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Thumbs</title><media:thumbnail url="https://thumbs.example/icon.jpg" /><item><guid>1</guid><title>One</title></item></channel></rss>`);

    expect(imported).toMatchObject({ kind: "feed", feed: { iconUrl: "https://thumbs.example/icon.jpg" } });
  });

  it("walks nested OPML and removes duplicate feed URLs", async () => {
    const imported = parseImport(await fixture("sample.opml"));

    expect(imported.kind).toBe("opml");
    if (imported.kind !== "opml") return;
    expect(imported.subscriptions).toEqual([
      { title: "City Notes", url: "https://notes.example/feed.xml", siteUrl: "https://notes.example/" },
      { title: "Signal Field", url: "https://field.example/atom.xml", siteUrl: undefined }
    ]);
  });

  it("exports remote subscriptions as portable OPML and excludes local snapshots", () => {
    const exported = serializeOpml([
      { title: "Design & <Code>", url: "https://design.example/feed?x=1&y=2", siteUrl: "https://design.example/" },
      { title: "Imported snapshot" }
    ]);
    const imported = parseImport(exported);

    expect(exported).toContain('text="Design &amp; &lt;Code&gt;"');
    expect(exported).toContain('xmlUrl="https://design.example/feed?x=1&amp;y=2"');
    expect(exported).not.toContain("Imported snapshot");
    expect(imported).toEqual({
      kind: "opml",
      subscriptions: [{ title: "Design & <Code>", url: "https://design.example/feed?x=1&y=2", siteUrl: "https://design.example/" }]
    });
  });

  it("rejects malformed and unsupported XML", () => {
    expect(() => parseImport("<rss><channel></rss>")).toThrow(FeedParseError);
    expect(() => parseImport("<html><body>not a feed</body></html>")).toThrow("not a supported RSS");
  });

  it("never returns unsafe URL schemes", () => {
    const imported = parseImport(`<?xml version="1.0"?><rss><channel><title>Safe</title><link>javascript:alert(1)</link><item><guid>1</guid><title>One</title><link>data:text/html,no</link><description><![CDATA[<img src=x onerror=alert(1)>text]]></description></item></channel></rss>`);

    expect(imported.kind).toBe("feed");
    if (imported.kind !== "feed") return;
    expect(imported.feed.siteUrl).toBeUndefined();
    expect(imported.feed.entries[0].url).toBeUndefined();
    expect(imported.feed.entries[0].content).toBe("text");
  });
});

describe("retainNewest", () => {
  it("keeps newest entries and resolves matching timestamps by ID", () => {
    const entries = [
      { id: "a", publishedAt: 100 },
      { id: "c", publishedAt: 200 },
      { id: "b", publishedAt: 200 },
      { id: "d", publishedAt: 50 }
    ];

    expect(retainNewest(entries, 2)).toEqual([
      { id: "c", publishedAt: 200 },
      { id: "b", publishedAt: 200 }
    ]);
  });
});

describe("local entry storage", () => {
  it("retains 200 newest entries and preserves read state across refreshes", async () => {
    const { feed } = await createFeed({ title: "Storage test", url: "https://storage.example/feed.xml" });
    await saveEntries(
      feed.id,
      Array.from({ length: 201 }, (_, index) => ({
        externalId: `entry-${index}`,
        title: `Entry ${index}`,
        content: "Original content",
        publishedAt: index
      }))
    );

    const page = await listEntries({ feedId: feed.id, limit: 250 });
    expect(page.entries).toHaveLength(200);
    expect(page.entries[0].externalId).toBe("entry-200");
    expect(page.entries.at(-1)?.externalId).toBe("entry-1");

    const saved = page.entries[0];
    await setEntryRead(saved.id, true);
    await saveEntries(feed.id, [{ externalId: "entry-200", title: "Updated", content: "Fresh content", publishedAt: 200 }]);

    await expect(getEntry(saved.id)).resolves.toMatchObject({
      title: "Updated",
      content: "Fresh content",
      read: true
    });
  });

  it("marks only the selected feed's unread entries as read", async () => {
    const { feed } = await createFeed({ title: "Mark read", url: "https://mark-read.example/feed.xml" });
    const { feed: otherFeed } = await createFeed({ title: "Other feed", url: "https://other.example/feed.xml" });
    await saveEntries(feed.id, [
      { externalId: "one", title: "One", content: "", publishedAt: 2 },
      { externalId: "two", title: "Two", content: "", publishedAt: 1 }
    ]);
    await saveEntries(otherFeed.id, [{ externalId: "three", title: "Three", content: "", publishedAt: 3 }]);

    await expect(markFeedRead(feed.id)).resolves.toBe(2);
    await expect(listEntries({ feedId: feed.id, unreadOnly: true })).resolves.toMatchObject({ entries: [] });
    await expect(listEntries({ feedId: otherFeed.id, unreadOnly: true })).resolves.toMatchObject({
      entries: [{ externalId: "three" }]
    });
  });
});
