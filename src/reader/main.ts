import "./styles.css";
import {
  createFeed,
  getEntry,
  listEntries,
  listFeeds,
  markFeedRead,
  removeFeed,
  saveEntries,
  setEntryRead,
  updateFeed
} from "../lib/database";
import { FeedParseError, parseImport, serializeOpml } from "../lib/feed-parser";
import type { CacheRebuildSummary, Entry, EntryCursor, Feed } from "../types";
import { shouldAnimateUnreadRemoval, shouldDeferUnreadReload, type ReaderView } from "./unread-preview";

type View = ReaderView;
type Modal = "add" | "manage" | undefined;

const root = document.querySelector<HTMLDivElement>("#app") as HTMLDivElement;
if (!root) throw new Error("Buoy root is missing.");

const surface = document.body.dataset.surface === "sidebar" ? "sidebar" : "reader";
const state: {
  feeds: Feed[];
  entries: Entry[];
  view: View;
  selectedFeedId?: string;
  activeEntry?: Entry;
  removingEntryId?: string;
  cursor?: EntryCursor;
  hasMore: boolean;
  loading: boolean;
  busy: boolean;
  modal: Modal;
  notice?: string;
} = {
  feeds: [],
  entries: [],
  view: "all",
  hasMore: false,
  loading: true,
  busy: false,
  modal: undefined
};

let requestVersion = 0;
let toastTimer: number | undefined;
let toastExitTimer: number | undefined;
let visibleNotice: string | undefined;
let toastLeaving = false;

root.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLElement>("[data-action]");
  if (target) void handleAction(target);
});

root.addEventListener("submit", (event) => {
  if (!(event.target instanceof HTMLFormElement) || event.target.id !== "add-url-form") return;
  event.preventDefault();
  const url = new FormData(event.target).get("url");
  if (typeof url === "string") void addUrl(url);
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.name === "feed-filter") {
    state.selectedFeedId = target.value || undefined;
    void reload(true);
  }
  if (target.name === "import-file" && target instanceof HTMLInputElement && target.files?.[0]) {
    void importFile(target.files[0]);
  }
  if (target.name === "feed-notifications" && target instanceof HTMLInputElement) {
    void setNotifications(target.value, target.checked);
  }
});

root.addEventListener("dragover", (event) => event.preventDefault());
root.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) void importFile(file);
});

root.addEventListener("error", (event) => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.classList.contains("source-thumbnail")) {
    image.parentElement?.classList.add("has-image-error");
  }
}, true);

browser.runtime.onMessage.addListener((message: unknown) => {
  if (isDataChanged(message) && !shouldDeferUnreadReload(state.view, state.activeEntry, state.removingEntryId)) {
    void reload(true);
  }
});

void reload(true);

async function reload(reset: boolean): Promise<void> {
  const version = ++requestVersion;
  state.loading = true;
  if (reset) {
    state.cursor = undefined;
    state.entries = [];
  }
  render();

  const [feeds, page] = await Promise.all([
    listFeeds(),
    listEntries({
      feedId: state.selectedFeedId,
      unreadOnly: state.view === "unread",
      cursor: reset ? undefined : state.cursor,
      limit: 60
    })
  ]);
  if (version !== requestVersion) return;

  state.feeds = feeds;
  state.entries = reset ? page.entries : [...state.entries, ...page.entries];
  state.cursor = state.entries.at(-1)
    ? { publishedAt: state.entries.at(-1)!.publishedAt, id: state.entries.at(-1)!.id }
    : undefined;
  state.hasMore = page.hasMore;
  state.loading = false;
  render();
}

async function handleAction(target: HTMLElement): Promise<void> {
  const action = target.dataset.action;
  if (!action || state.busy) return;

  if (action === "set-view") {
    state.view = target.dataset.view === "unread" ? "unread" : "all";
    await reload(true);
    return;
  }
  if (action === "set-feed") {
    state.selectedFeedId = target.dataset.feed || undefined;
    await reload(true);
    return;
  }
  if (action === "load-more") {
    await reload(false);
    return;
  }
  if (action === "open-add") {
    state.modal = "add";
    render();
    return;
  }
  if (action === "export-opml") {
    exportOpml();
    return;
  }
  if (action === "open-manage") {
    state.modal = "manage";
    render();
    return;
  }
  if (action === "close-modal") {
    state.modal = undefined;
    state.notice = undefined;
    render();
    return;
  }
  if (action === "refresh-all") {
    await refreshAll();
    return;
  }
  if (action === "rebuild-cache") {
    await rebuildCachedFeeds();
    return;
  }
  if (action === "refresh-feed") {
    const feedId = target.dataset.feed;
    if (feedId) await refreshOne(feedId);
    return;
  }
  if (action === "mark-feed-read") {
    const feedId = target.dataset.feed;
    if (feedId) await markSelectedFeedRead(feedId);
    return;
  }
  if (action === "select-entry") {
    const entryId = target.dataset.entry;
    if (entryId) await selectEntry(entryId);
    return;
  }
  if (action === "close-preview") {
    await closePreview();
    return;
  }
  if (action === "toggle-read") {
    const entry = activeEntry();
    if (!entry) return;
    await setEntryRead(entry.id, !entry.read);
    entry.read = !entry.read;
    await dataChanged();
    render();
    return;
  }
  if (action === "open-original") {
    const entry = activeEntry();
    if (entry?.url) await browser.runtime.sendMessage({ type: "openOriginal", url: entry.url });
    return;
  }
  if (action === "remove-feed") {
    const feedId = target.dataset.feed;
    const feed = state.feeds.find((item) => item.id === feedId);
    if (feedId && feed && window.confirm(`Remove ${feed.title} and its saved posts?`)) {
      state.busy = true;
      render();
      await removeFeed(feedId);
      if (state.selectedFeedId === feedId) state.selectedFeedId = undefined;
      if (activeEntry()?.feedId === feedId) state.activeEntry = undefined;
      state.notice = `${feed.title} removed.`;
      state.busy = false;
      await dataChanged();
      await reload(true);
    }
  }
}

async function selectEntry(entryId: string): Promise<void> {
  const entry = state.entries.find((item) => item.id === entryId) ?? (await getEntry(entryId));
  if (!entry) return;

  state.activeEntry = entry;
  const wasUnread = !entry.read;
  if (wasUnread) {
    entry.read = true;
  }
  render();

  if (wasUnread) {
    await setEntryRead(entry.id, true);
    await dataChanged();
  }
}

async function closePreview(): Promise<void> {
  const entry = state.activeEntry;
  state.activeEntry = undefined;
  const animateRemoval = shouldAnimateUnreadRemoval(state.view, entry);
  if (animateRemoval && entry) state.removingEntryId = entry.id;
  render();

  if (!entry || state.view !== "unread") return;
  try {
    if (animateRemoval) await animateUnreadEntryRemoval(entry.id);
    await reload(true);
  } finally {
    state.removingEntryId = undefined;
  }
}

async function animateUnreadEntryRemoval(entryId: string): Promise<void> {
  const card = Array.from(root.querySelectorAll<HTMLElement>("[data-entry-card]")).find(
    (element) => element.dataset.entryCard === entryId
  );
  if (!card || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  card.style.height = `${card.getBoundingClientRect().height}px`;
  card.style.overflow = "hidden";
  await nextFrame();
  card.classList.add("is-leaving");
  card.style.height = "0px";
  await waitForRemovalTransition(card);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitForRemovalTransition(element: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      element.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(timeout);
      resolve();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "height") finish();
    };
    const timeout = window.setTimeout(finish, 240);
    element.addEventListener("transitionend", onTransitionEnd);
  });
}

async function refreshAll(): Promise<void> {
  state.busy = true;
  state.notice = "Refreshing feeds...";
  render();
  try {
    await browser.runtime.sendMessage({ type: "refreshAll" });
    state.notice = "Feeds refreshed.";
  } catch {
    state.notice = "Could not refresh feeds.";
  }
  state.busy = false;
  await reload(true);
}

async function rebuildCachedFeeds(): Promise<void> {
  const remoteFeeds = state.feeds.filter((feed) => feed.url);
  if (!remoteFeeds.length) {
    state.notice = "No remote feeds to rebuild.";
    render();
    return;
  }
  if (!window.confirm("Clear cached posts and refresh all remote feeds now? Posts absent from fresh responses will be removed. Read state is preserved for matching posts.")) return;

  state.busy = true;
  state.notice = "Clearing cache and refreshing feeds...";
  render();
  try {
    const summary = await browser.runtime.sendMessage({ type: "rebuildCache" }) as CacheRebuildSummary;
    state.notice = formatCacheRebuildSummary(summary);
  } catch {
    state.notice = "Could not rebuild feed cache.";
  }
  state.busy = false;
  await reload(true);
}

async function refreshOne(feedId: string): Promise<void> {
  state.busy = true;
  render();
  try {
    await browser.runtime.sendMessage({ type: "refreshFeed", feedId });
    state.notice = "Feed refreshed.";
  } catch {
    state.notice = "Could not refresh this feed.";
  }
  state.busy = false;
  await reload(true);
}

async function markSelectedFeedRead(feedId: string): Promise<void> {
  const feed = state.feeds.find((item) => item.id === feedId);
  if (!feed) return;

  state.busy = true;
  render();
  const updated = await markFeedRead(feedId);
  state.notice = updated ? `${updated} post${updated === 1 ? "" : "s"} marked read.` : "No unread posts in this feed.";
  state.busy = false;
  await dataChanged();
  if (shouldDeferUnreadReload(state.view, state.activeEntry, state.removingEntryId)) render();
  else await reload(true);
}

async function addUrl(value: string): Promise<void> {
  let url: string;
  try {
    const parsed = new URL(value.trim());
    if (!isHttpUrl(parsed)) throw new Error();
    url = parsed.href;
  } catch {
    state.notice = "Enter a valid http(s) feed URL.";
    render();
    return;
  }

  state.busy = true;
  render();
  const { feed, created } = await createFeed({ title: new URL(url).hostname, url, isLocal: false });
  state.modal = undefined;
  state.notice = created ? "Feed added. Fetching latest posts..." : "That feed is already saved.";
  state.busy = false;
  await dataChanged();
  if (created) await refreshOne(feed.id);
  else await reload(true);
}

async function importFile(file: File): Promise<void> {
  state.busy = true;
  state.notice = "Importing...";
  render();
  try {
    const imported = parseImport(await file.text());
    if (imported.kind === "opml") {
      let added = 0;
      let duplicates = 0;
      for (const subscription of imported.subscriptions) {
        const result = await createFeed({
          title: subscription.title || new URL(subscription.url).hostname,
          url: subscription.url,
          siteUrl: subscription.siteUrl,
          isLocal: false
        });
        if (result.created) added += 1;
        else duplicates += 1;
      }
      const summary = `${added} feed${added === 1 ? "" : "s"} imported${duplicates ? `, ${duplicates} already saved` : ""}.`;
      state.modal = undefined;
      state.busy = false;
      await dataChanged();
      if (added) await browser.runtime.sendMessage({ type: "refreshAll" });
      state.notice = summary;
      await reload(true);
      return;
    }

    const { feed, created } = await createFeed({
      title: imported.feed.title,
      url: imported.feed.selfUrl,
      siteUrl: imported.feed.siteUrl,
      iconUrl: imported.feed.iconUrl,
      description: imported.feed.description,
      isLocal: !imported.feed.selfUrl
    });
    await updateFeed(feed.id, {
      title: imported.feed.title || feed.title,
      siteUrl: imported.feed.siteUrl || feed.siteUrl,
      iconUrl: imported.feed.iconUrl || feed.iconUrl,
      description: imported.feed.description || feed.description
    });
    const addedEntries = await saveEntries(feed.id, imported.feed.entries);
    state.modal = undefined;
    state.notice = `${created ? "Feed" : "Snapshot"} imported with ${addedEntries.length} new post${addedEntries.length === 1 ? "" : "s"}.`;
    state.busy = false;
    await dataChanged();
    if (feed.url) await refreshOne(feed.id);
    else await reload(true);
  } catch (error) {
    state.busy = false;
    state.notice = error instanceof FeedParseError ? error.message : "Could not import this file.";
    render();
  }
}

function exportOpml(): void {
  const subscriptions = state.feeds.filter((feed) => feed.url);
  if (!subscriptions.length) {
    state.notice = "No remote subscriptions to export.";
    render();
    return;
  }

  const file = new Blob([serializeOpml(subscriptions)], { type: "text/x-opml;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `buoy-subscriptions-${new Date().toISOString().slice(0, 10)}.opml`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);

  const localSnapshots = state.feeds.length - subscriptions.length;
  state.notice = `${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"} exported${localSnapshots ? ". Local snapshots are not included" : "."}`;
  render();
}

async function setNotifications(feedId: string, enabled: boolean): Promise<void> {
  if (enabled) {
    const alreadyAllowed = await browser.permissions.contains({ permissions: ["notifications"] });
    if (!alreadyAllowed) {
      const allowed = await browser.permissions.request({ permissions: ["notifications"] });
      if (!allowed) {
        state.notice = "Notifications were not allowed.";
        render();
        return;
      }
    }
  }
  await updateFeed(feedId, { notify: enabled });
  state.notice = enabled ? "Notifications enabled for this feed." : "Notifications disabled for this feed.";
  await dataChanged();
  await reload(true);
}

async function dataChanged(): Promise<void> {
  await browser.runtime.sendMessage({ type: "dataChanged", source: "reader" });
}

function activeEntry(): Entry | undefined {
  return state.activeEntry;
}

function render(): void {
  scheduleToastDismissal();
  const markup = `
    <div class="app app--${surface}">
      ${renderSourceRail()}
      ${renderFeedColumn()}
      ${renderPreview()}
      ${state.modal ? renderModal() : ""}
      ${state.notice ? `<div class="toast ${toastLeaving ? "is-leaving" : ""}" role="status">${escapeHtml(state.notice)}</div>` : ""}
    </div>
  `;
  // Feed-derived values are escaped before detached parsing and DOM insertion.
  const parsedDocument = new DOMParser().parseFromString(markup, "text/html");
  root.replaceChildren(...Array.from(parsedDocument.body.childNodes));
}

function scheduleToastDismissal(): void {
  if (!state.notice) {
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastExitTimer);
    visibleNotice = undefined;
    toastLeaving = false;
    return;
  }
  if (state.notice === visibleNotice) return;

  window.clearTimeout(toastTimer);
  window.clearTimeout(toastExitTimer);
  visibleNotice = state.notice;
  toastLeaving = false;
  const notice = state.notice;
  toastTimer = window.setTimeout(() => {
    if (state.notice !== notice) return;
    toastLeaving = true;
    render();
    toastExitTimer = window.setTimeout(() => {
      if (state.notice !== notice) return;
      state.notice = undefined;
      render();
    }, 180);
  }, 2_000);
}

function renderSourceRail(): string {
  return `
    <aside class="source-rail" aria-label="Feed navigation">
      <div class="brand">${buoyMark()}<span>buoy</span></div>
      <button class="new-feed" data-action="open-add">${plusIcon()} Add feed</button>
      <div class="nav-section">
        ${viewButton("all", "All posts", allIcon())}
        ${viewButton("unread", "Unread", dotIcon())}
      </div>
      <div class="feed-list-heading"><span>Sources</span><button class="icon-button" data-action="open-manage" aria-label="Manage feeds">${settingsIcon()}</button></div>
      <div class="source-list">
        ${state.feeds.length ? state.feeds.map(sourceButton).join("") : `<p class="quiet">Your feeds will appear here.</p>`}
      </div>
      <p class="local-note">Stored only in Firefox</p>
    </aside>
  `;
}

function renderFeedColumn(): string {
  const selected = state.feeds.find((feed) => feed.id === state.selectedFeedId);
  const title = selected?.title || (state.view === "unread" ? "Unread" : "All posts");
  return `
    <section class="feed-column" aria-label="${escapeAttribute(title)}">
      <header class="topbar">
        <div class="compact-brand">${buoyMark()}<span>buoy</span></div>
        <p class="refresh-hint">Buoy automatically refreshes every 15 minutes</p>
        <div class="sidebar-filter">
          <select name="feed-filter" aria-label="Filter by feed">
            <option value="">All sources</option>
            ${state.feeds.map((feed) => `<option value="${escapeAttribute(feed.id)}" ${feed.id === state.selectedFeedId ? "selected" : ""}>${escapeHtml(feed.title)}</option>`).join("")}
          </select>
        </div>
        <div class="topbar-actions">
          <button class="icon-button" data-action="refresh-all" aria-label="Refresh all feeds" ${state.busy ? "disabled" : ""}>${refreshIcon()}</button>
          <button class="icon-button add-compact" data-action="open-add" aria-label="Add feed">${plusIcon()}</button>
        </div>
      </header>
      <div class="feed-heading">
        <div>
          <p class="eyebrow">${state.view === "unread" ? "Read later" : "Your current"}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        ${selected ? `<div class="feed-heading-actions"><button class="feed-action-button feed-action--mark" data-action="mark-feed-read" data-feed="${escapeAttribute(selected.id)}" aria-label="Mark all read" ${state.busy ? "disabled" : ""}><span class="feed-action-label">Mark all read</span>${markAllReadIcon()}</button><button class="feed-action-button feed-action--refresh" data-action="refresh-feed" data-feed="${escapeAttribute(selected.id)}" aria-label="Refresh" ${state.busy ? "disabled" : ""}><span class="feed-action-label">Refresh</span>${refreshIcon()}</button></div>` : ""}
      </div>
      <div class="entry-list">
        ${renderEntries()}
      </div>
    </section>
  `;
}

function renderEntries(): string {
  if (state.loading && !state.entries.length) return renderLoadingCards();
  if (!state.entries.length) {
    const hasFeeds = state.feeds.length > 0;
    return `
      <section class="empty-state">
        ${emptyIcon()}
        <h2>${hasFeeds ? "Nothing here yet" : "A quieter way to catch up"}</h2>
        <p>${hasFeeds ? "Try refreshing, changing the filter, or mark posts unread." : "Add a feed URL or import RSS, Atom, or OPML."}</p>
        ${hasFeeds ? "" : `<button class="new-feed" data-action="open-add">${plusIcon()} Add your first feed</button>`}
      </section>
    `;
  }
  return `
    ${state.entries.map(renderEntryCard).join("")}
    ${state.loading ? `<div class="inline-loading">Loading posts...</div>` : ""}
    ${state.hasMore && !state.loading ? `<button class="load-more" data-action="load-more">Load older posts</button>` : ""}
  `;
}

function renderEntryCard(entry: Entry): string {
  const feed = state.feeds.find((item) => item.id === entry.feedId);
  const active = entry.id === state.activeEntry?.id ? "is-active" : "";
  const image = entry.imageUrl
    ? `<img class="entry-image" src="${escapeAttribute(entry.imageUrl)}" alt="" loading="lazy" />`
    : "";
  return `
    <article class="entry-card ${entry.read ? "is-read" : "is-unread"} ${active}" data-entry-card="${escapeAttribute(entry.id)}">
      <button class="entry-hit" data-action="select-entry" data-entry="${escapeAttribute(entry.id)}" aria-label="Open ${escapeAttribute(entry.title)}">
        <div class="entry-meta">
          ${sourceMark(feed)}
          <span class="entry-source">${escapeHtml(feed?.title || "Imported feed")}</span>
          <span class="meta-separator">·</span>
          <time datetime="${new Date(entry.publishedAt || 0).toISOString()}">${formatDate(entry.publishedAt)}</time>
          ${entry.read ? "" : `<span class="unread-pip" aria-label="Unread"></span>`}
        </div>
        <div class="entry-body ${image ? "has-image" : ""}">
          <div class="entry-copy">
            <h2>${escapeHtml(entry.title)}</h2>
            ${entry.content ? `<p>${escapeHtml(clamp(entry.content, 240))}</p>` : ""}
          </div>
          ${image}
        </div>
      </button>
    </article>
  `;
}

function renderPreview(): string {
  const entry = activeEntry();
  if (!entry) {
    return `
      <aside class="preview-panel preview-panel--empty" aria-label="Article preview">
        <div>${buoyMark()}</div>
        <h2>Choose a post</h2>
        <p>Preview feed text here. Open original when you want full article.</p>
      </aside>
    `;
  }
  const feed = state.feeds.find((item) => item.id === entry.feedId);
  return `
    <aside class="preview-panel" aria-label="Article preview">
      <header class="preview-header">
        <button class="icon-button preview-close" data-action="close-preview" aria-label="Back to posts">${backIcon()}</button>
        <span>Preview</span>
        <button class="icon-button" data-action="toggle-read" aria-label="${entry.read ? "Mark unread" : "Mark read"}">${entry.read ? unreadIcon() : readIcon()}</button>
      </header>
      <article class="preview-content">
        <div class="entry-meta">
          ${sourceMark(feed)}
          <div><strong>${escapeHtml(feed?.title || "Imported feed")}</strong><time>${formatLongDate(entry.publishedAt)}</time></div>
        </div>
        <h2>${escapeHtml(entry.title)}</h2>
        ${entry.author ? `<p class="byline">By ${escapeHtml(entry.author)}</p>` : ""}
        ${entry.imageUrl ? `<img class="preview-image" src="${escapeAttribute(entry.imageUrl)}" alt="" />` : ""}
        ${entry.content ? `<p class="preview-text">${escapeHtml(entry.content)}</p>` : `<p class="preview-text quiet">This feed did not include a preview.</p>`}
      </article>
      <footer class="preview-footer">
        ${entry.url ? `<button class="open-original" data-action="open-original">Open original ${externalIcon()}</button>` : `<span class="quiet">No source link included</span>`}
      </footer>
    </aside>
  `;
}

function renderModal(): string {
  if (state.modal === "manage") {
    return `
      <div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-label="Manage feeds">
        <header><div><p class="eyebrow">Sources</p><h2>Manage feeds</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close">${closeIcon()}</button></header>
        <div class="migration-actions">
          <button class="text-button" data-action="open-add">Import OPML</button>
          <button class="text-button" data-action="export-opml">Export OPML</button>
          <button class="text-button" data-action="rebuild-cache" ${state.busy ? "disabled" : ""}>Clear cache &amp; refresh</button>
        </div>
        <div class="manage-list">
          ${state.feeds.length ? state.feeds.map(renderManageFeed).join("") : `<p class="quiet">No feeds added yet.</p>`}
        </div>
      </section></div>
    `;
  }
  return `
    <div class="modal-backdrop" role="presentation"><section class="modal add-modal" role="dialog" aria-modal="true" aria-label="Add a feed">
      <header><div><p class="eyebrow">New source</p><h2>Add to Buoy</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close">${closeIcon()}</button></header>
      <form id="add-url-form" class="url-form">
        <label for="feed-url">Feed URL</label>
        <div><input id="feed-url" name="url" type="url" placeholder="https://example.com/feed.xml" required autofocus /><button class="new-feed" type="submit" ${state.busy ? "disabled" : ""}>Add</button></div>
        <p>Buoy refreshes URL feeds every 15 minutes.</p>
      </form>
      <div class="import-divider"><span>or</span></div>
      <label class="file-drop" for="import-file">
        ${uploadIcon()}
        <strong>Import a file</strong>
        <span>RSS, XML, Atom, or OPML</span>
        <input id="import-file" name="import-file" type="file" accept=".rss,.xml,.atom,.opml,application/xml,text/xml" />
      </label>
    </section></div>
  `;
}

function renderManageFeed(feed: Feed): string {
  return `
    <div class="manage-feed">
      ${sourceMark(feed)}
      <div class="manage-feed-copy"><strong>${escapeHtml(feed.title)}</strong><span>${feed.isLocal ? "Imported snapshot" : compactHost(feed.url)}</span>${feed.lastError ? `<small>${escapeHtml(feed.lastError)}</small>` : ""}</div>
      <label class="notification-toggle" title="Notify when this feed has new posts"><input name="feed-notifications" type="checkbox" value="${escapeAttribute(feed.id)}" ${feed.notify ? "checked" : ""} /><span>${bellIcon()}</span></label>
      <button class="icon-button destructive" data-action="remove-feed" data-feed="${escapeAttribute(feed.id)}" aria-label="Remove ${escapeAttribute(feed.title)}">${trashIcon()}</button>
    </div>
  `;
}

function sourceButton(feed: Feed): string {
  return `<button class="source-button ${feed.id === state.selectedFeedId ? "is-selected" : ""}" data-action="set-feed" data-feed="${escapeAttribute(feed.id)}">${sourceMark(feed)}<span>${escapeHtml(feed.title)}</span>${feed.lastError ? `<i title="${escapeAttribute(feed.lastError)}"></i>` : ""}</button>`;
}

function viewButton(view: View, label: string, icon: string): string {
  return `<button class="nav-button ${state.view === view && !state.selectedFeedId ? "is-selected" : ""}" data-action="set-view" data-view="${view}">${icon}<span>${label}</span></button>`;
}

function renderLoadingCards(): string {
  return Array.from({ length: 5 }, () => `<div class="loading-card"><span></span><span></span><span></span></div>`).join("");
}

function sourceMark(feed?: Feed): string {
  const thumbnail = feed?.iconUrl
    ? `<img class="source-thumbnail" src="${escapeAttribute(feed.iconUrl)}" alt="" loading="lazy" />`
    : "";
  return `<span class="source-mark ${thumbnail ? "has-thumbnail" : ""}" aria-hidden="true">${thumbnail}<span class="source-fallback">${rssIcon()}</span></span>`;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "Recently";
  const difference = Date.now() - timestamp;
  if (difference < 3_600_000) return `${Math.max(1, Math.round(difference / 60_000))}m`;
  if (difference < 86_400_000) return `${Math.round(difference / 3_600_000)}h`;
  if (difference < 604_800_000) return `${Math.round(difference / 86_400_000)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

function formatLongDate(timestamp: number): string {
  if (!timestamp) return "Recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function compactHost(url?: string): string {
  try {
    return url ? new URL(url).hostname : "Local file";
  } catch {
    return "Local file";
  }
}

function formatCacheRebuildSummary(summary: CacheRebuildSummary): string {
  if (!summary.refreshed && !summary.failed) return "No remote feeds to rebuild.";
  const refreshed = `${summary.refreshed} feed${summary.refreshed === 1 ? "" : "s"} refreshed`;
  return summary.failed ? `${refreshed}, ${summary.failed} failed.` : `${refreshed}.`;
}

function clamp(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length).trimEnd()}...` : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}

function isDataChanged(value: unknown): boolean {
  return typeof value === "object" && value !== null && "type" in value && (value as { type?: unknown }).type === "dataChanged";
}

function buoyMark(): string {
  return `<svg class="buoy-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="buoy-gradient" x1="4" y1="3" x2="27" y2="29"><stop stop-color="#ffb26b"/><stop offset=".5" stop-color="#fa5b85"/><stop offset="1" stop-color="#833ab4"/></linearGradient></defs><circle cx="16" cy="16" r="14" fill="url(#buoy-gradient)"/><path d="M16 6.6c3.1 3.4 4.7 6.2 4.7 8.5 0 2.9-2 4.9-4.7 4.9s-4.7-2-4.7-4.9c0-2.3 1.6-5.1 4.7-8.5Z" fill="#fff"/><path d="M9.8 21.1c4-1.5 8.4-1.5 12.4 0" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="2"/></svg>`;
}

function plusIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`; }
function refreshIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.5 9A7 7 0 0 0 6.5 7M18.5 5v4h-4M5.5 15a7 7 0 0 0 12 2M5.5 19v-4h4"/></svg>`; }
function markAllReadIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 12 3 3 5-6M10 14l2 2 6-7"/></svg>`; }
function settingsIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 13.3v-2.6l-2-.5a6.7 6.7 0 0 0-.7-1.6l1.1-1.8L16 5l-1.8 1.1a6.7 6.7 0 0 0-1.6-.7l-.5-2H9.5l-.5 2a6.7 6.7 0 0 0-1.6.7L5.6 5 3.8 6.8l1.1 1.8a6.7 6.7 0 0 0-.7 1.6l-2 .5v2.6l2 .5a6.7 6.7 0 0 0 .7 1.6l-1.1 1.8L5.6 19l1.8-1.1a6.7 6.7 0 0 0 1.6.7l.5 2h2.6l.5-2a6.7 6.7 0 0 0 1.6-.7L16 19l1.8-1.8-1.1-1.8a6.7 6.7 0 0 0 .7-1.6l2-.5Z"/></svg>`; }
function allIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>`; }
function dotIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/></svg>`; }
function rssIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="1.6" fill="currentColor" stroke="none"/><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/></svg>`; }
function backIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h12"/></svg>`; }
function closeIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`; }
function readIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>`; }
function unreadIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>`; }
function externalIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4"/></svg>`; }
function uploadIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 15v4h14v-4"/></svg>`; }
function trashIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v5m4-5v5M9 7l1-3h4l1 3m-9 0 1 13h10l1-13"/></svg>`; }
function bellIcon(): string { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 10a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4"/></svg>`; }
function emptyIcon(): string { return `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 36c13-8 27-8 40 0" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="3"/><path d="M32 11c7 8 10.5 14 10.5 19 0 6.5-4.6 11-10.5 11S21.5 36.5 21.5 30c0-5 3.5-11 10.5-19Z" fill="none" stroke="currentColor" stroke-width="3"/></svg>`; }
