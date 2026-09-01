import type { Feed, OpmlSubscription, ParsedEntry, ParsedFeed, ParsedImport } from "../types";

const MAX_TEXT_LENGTH = 12_000;

export class FeedParseError extends Error {}

export function parseImport(xml: string, sourceUrl?: string): ParsedImport {
  const document = parseXml(xml);
  const root = document.documentElement;
  const rootName = root.localName.toLowerCase();

  if (rootName === "opml") {
    const subscriptions = parseOpml(root);
    if (!subscriptions.length) {
      throw new FeedParseError("No feed URLs found in this OPML file.");
    }
    return { kind: "opml", subscriptions };
  }

  if (rootName === "feed") {
    return { kind: "feed", feed: parseAtom(root, sourceUrl) };
  }

  if (rootName === "rss" || rootName === "rdf") {
    return { kind: "feed", feed: parseRss(root, sourceUrl) };
  }

  throw new FeedParseError("This file is not a supported RSS, Atom, or OPML document.");
}

export function serializeOpml(feeds: ReadonlyArray<Pick<Feed, "title" | "url" | "siteUrl">>): string {
  const outlines = feeds
    .filter((feed): feed is Pick<Feed, "title" | "url" | "siteUrl"> & { url: string } => Boolean(feed.url))
    .map((feed) => {
      const attributes = [
        'type="rss"',
        `text="${escapeXml(feed.title || "Untitled feed")}"`,
        `title="${escapeXml(feed.title || "Untitled feed")}"`,
        `xmlUrl="${escapeXml(feed.url)}"`
      ];
      if (feed.siteUrl) attributes.push(`htmlUrl="${escapeXml(feed.siteUrl)}"`);
      return `    <outline ${attributes.join(" ")} />`;
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head><title>Buoy subscriptions</title></head>",
    "  <body>",
    ...outlines,
    "  </body>",
    "</opml>",
    ""
  ].join("\n");
}

function parseXml(xml: string): XMLDocument {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (
    document.documentElement.localName.toLowerCase() === "parsererror" ||
    document.getElementsByTagName("parsererror").length > 0
  ) {
    throw new FeedParseError("This XML file could not be parsed.");
  }
  return document;
}

function parseRss(root: Element, sourceUrl?: string): ParsedFeed {
  const channel = directChild(root, "channel") ?? descendant(root, "channel");
  const context = channel ?? root;
  const title = textOf(context, "title") || hostName(sourceUrl) || "Untitled feed";
  const siteUrl = safeUrl(textOf(context, "link"), sourceUrl);
  const selfUrl = atomLink(context, "self", sourceUrl);
  const image = directChild(context, "image");
  const iconUrl =
    safeUrl(textOf(image, "url"), sourceUrl) ??
    safeUrl(attributeOf(directChildWithAttribute(context, "image", "href"), "href"), sourceUrl) ??
    safeUrl(attributeOf(directChildWithAttribute(context, "thumbnail", "url"), "url"), sourceUrl);
  const description = normalizeText(textOf(context, "description") || textOf(context, "subtitle"));
  const items = directChildren(context, "item").length
    ? directChildren(context, "item")
    : directChildren(root, "item");

  return {
    title: normalizeText(title) || "Untitled feed",
    siteUrl,
    selfUrl,
    iconUrl,
    description,
    entries: uniqueEntries(items.map((item) => parseRssItem(item, sourceUrl)))
  };
}

function parseRssItem(item: Element, sourceUrl?: string): ParsedEntry {
  const link = safeUrl(textOf(item, "link"), sourceUrl) ?? enclosureUrl(item, sourceUrl);
  const title = normalizeText(textOf(item, "title")) || "Untitled entry";
  const date = parseDate(textOf(item, "pubDate") || textOf(item, "date") || textOf(item, "published"));
  const externalId =
    normalizeText(textOf(item, "guid")) ||
    normalizeText(textOf(item, "id")) ||
    link ||
    `${title}:${date}`;
  const content = normalizeText(
    textOf(item, "encoded") || textOf(item, "content") || textOf(item, "description") || textOf(item, "summary")
  );

  return {
    externalId,
    title,
    url: link,
    author: normalizeText(textOf(item, "creator") || textOf(item, "author")) || undefined,
    content,
    imageUrl: entryImage(item, sourceUrl),
    publishedAt: date
  };
}

function parseAtom(root: Element, sourceUrl?: string): ParsedFeed {
  const title = normalizeText(textOf(root, "title")) || hostName(sourceUrl) || "Untitled feed";
  const entries = directChildren(root, "entry");

  return {
    title,
    siteUrl: atomLink(root, "alternate", sourceUrl) ?? atomLink(root, undefined, sourceUrl),
    selfUrl: atomLink(root, "self", sourceUrl),
    iconUrl: safeUrl(textOf(root, "icon") || textOf(root, "logo"), sourceUrl),
    description: normalizeText(textOf(root, "subtitle")) || undefined,
    entries: uniqueEntries(entries.map((entry) => parseAtomEntry(entry, sourceUrl)))
  };
}

function parseAtomEntry(entry: Element, sourceUrl?: string): ParsedEntry {
  const title = normalizeText(textOf(entry, "title")) || "Untitled entry";
  const url = atomLink(entry, "alternate", sourceUrl) ?? atomLink(entry, undefined, sourceUrl);
  const date = parseDate(textOf(entry, "published") || textOf(entry, "updated"));
  const externalId = normalizeText(textOf(entry, "id")) || url || `${title}:${date}`;
  const author = directChild(entry, "author");

  return {
    externalId,
    title,
    url,
    author: normalizeText(textOf(author, "name") || textOf(entry, "author")) || undefined,
    content: normalizeText(textOf(entry, "content") || textOf(entry, "summary") || textOf(entry, "description")),
    imageUrl: entryImage(entry, sourceUrl),
    publishedAt: date
  };
}

function parseOpml(root: Element): OpmlSubscription[] {
  const subscriptions = new Map<string, OpmlSubscription>();
  const walk = (parent: Element) => {
    for (const outline of directChildren(parent, "outline")) {
      const url = safeUrl(attributeOf(outline, "xmlUrl") || attributeOf(outline, "xmlurl"));
      if (url) {
        if (!subscriptions.has(url)) {
          subscriptions.set(url, {
            url,
            title: normalizeAttributeText(attributeOf(outline, "title") || attributeOf(outline, "text")) || undefined,
            siteUrl: safeUrl(attributeOf(outline, "htmlUrl") || attributeOf(outline, "htmlurl"))
          });
        }
      }
      walk(outline);
    }
  };
  walk(directChild(root, "body") ?? root);
  return [...subscriptions.values()];
}

function uniqueEntries(entries: ParsedEntry[]): ParsedEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.externalId)) return false;
    seen.add(entry.externalId);
    return true;
  });
}

function entryImage(entry: Element, sourceUrl?: string): string | undefined {
  const enclosure = directChildren(entry, "enclosure").find((item) => {
    const type = attributeOf(item, "type") || "";
    return type.startsWith("image/");
  });
  const media = descendant(entry, "thumbnail") ?? descendant(entry, "content");
  return (
    safeUrl(attributeOf(enclosure, "url"), sourceUrl) ??
    safeUrl(attributeOf(media, "url"), sourceUrl) ??
    safeUrl(attributeOf(directChild(entry, "image"), "href"), sourceUrl)
  );
}

function enclosureUrl(entry: Element, sourceUrl?: string): string | undefined {
  return safeUrl(attributeOf(directChild(entry, "enclosure"), "url"), sourceUrl);
}

function atomLink(element: Element, rel: string | undefined, sourceUrl?: string): string | undefined {
  const links = directChildren(element, "link");
  const match = links.find((link) => {
    const value = (attributeOf(link, "rel") || "alternate").toLowerCase();
    return rel ? value === rel : value === "alternate";
  });
  return safeUrl(attributeOf(match, "href") || match?.textContent, sourceUrl);
}

function directChildren(element: Element, name: string): Element[] {
  return Array.from(element.children).filter((child) => child.localName.toLowerCase() === name.toLowerCase());
}

function directChild(element: Element | undefined, name: string): Element | undefined {
  return element ? directChildren(element, name)[0] : undefined;
}

function descendant(element: Element | undefined, name: string): Element | undefined {
  if (!element) return undefined;
  return Array.from(element.getElementsByTagNameNS("*", name))[0] ??
    Array.from(element.getElementsByTagName(name))[0];
}

function directChildWithAttribute(element: Element | undefined, name: string, attribute: string): Element | undefined {
  return element ? directChildren(element, name).find((child) => child.hasAttribute(attribute)) : undefined;
}

function textOf(element: Element | undefined, name: string): string {
  return directChild(element, name)?.textContent?.trim() || "";
}

function attributeOf(element: Element | undefined, attribute: string): string | undefined {
  return element?.getAttribute(attribute) ?? undefined;
}

function normalizeText(value: string | undefined): string {
  if (!value) return "";
  const document = new DOMParser().parseFromString(value, "text/html");
  return (document.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

function normalizeAttributeText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH) || "";
}

function parseDate(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function safeUrl(value: string | undefined | null, base?: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = base ? new URL(value.trim(), base) : new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function hostName(value?: string): string | undefined {
  try {
    return value ? new URL(value).hostname : undefined;
  } catch {
    return undefined;
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  })[character]!);
}
