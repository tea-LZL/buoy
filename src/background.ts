import { applyActionBadge, unreadBadgeText } from "./lib/action-badge";
import { listEntries } from "./lib/database";
import { rebuildCache, refreshAll, refreshFeed } from "./lib/feed-service";
import type { RefreshResult } from "./types";

const REFRESH_ALARM = "buoy:refresh";

browser.runtime.onInstalled.addListener(() => {
  void ensureRefreshAlarm();
  void updateBadge();
});

browser.runtime.onStartup.addListener(() => {
  void ensureRefreshAlarm();
  void updateBadge();
});

browser.action.onClicked.addListener(() => {
  void browser.tabs.create({ url: browser.runtime.getURL("reader.html") });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) void refreshAndSignal();
});

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isMessage(message)) return undefined;
  if (message.type === "refreshAll") return refreshAndSignal();
  if (message.type === "refreshFeed" && message.feedId) return refreshOneAndSignal(message.feedId);
  if (message.type === "rebuildCache") return rebuildCacheAndSignal();
  if (message.type === "dataChanged" && message.source !== "background") {
    return updateBadge().then(signalDataChanged);
  }
  if (message.type === "openOriginal" && message.url) return browser.tabs.create({ url: message.url });
  return undefined;
});

async function ensureRefreshAlarm(): Promise<void> {
  await browser.alarms.create(REFRESH_ALARM, { periodInMinutes: 15 });
}

async function refreshAndSignal(): Promise<RefreshResult[]> {
  const results = await refreshAll();
  await notifyNewEntries(results);
  await updateBadge();
  await signalDataChanged();
  return results;
}

async function refreshOneAndSignal(feedId: string): Promise<RefreshResult> {
  const result = await refreshFeed(feedId);
  await notifyNewEntries([result]);
  await updateBadge();
  await signalDataChanged();
  return result;
}

async function rebuildCacheAndSignal() {
  const summary = await rebuildCache();
  await updateBadge();
  await signalDataChanged();
  return summary;
}

async function updateBadge(): Promise<void> {
  const { entries } = await listEntries({ unreadOnly: true, limit: 1_000 });
  await applyActionBadge(unreadBadgeText(entries.length), browser.action, browser.tabs);
}

async function notifyNewEntries(results: RefreshResult[]): Promise<void> {
  const allowed = await browser.permissions.contains({ permissions: ["notifications"] });
  if (!allowed) return;

  for (const result of results) {
    if (!result.feed.notify || !result.hadPreviousFetch || !result.addedEntries.length) continue;
    const newest = result.addedEntries[0];
    const message =
      result.addedEntries.length === 1
        ? newest.title
        : `${result.addedEntries.length} new posts, latest: ${newest.title}`;
    await browser.notifications.create(`buoy:${result.feed.id}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/buoy.svg"),
      title: result.feed.title,
      message
    });
  }
}

async function signalDataChanged(): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: "dataChanged", source: "background" });
  } catch {
    // No reader surface is currently open.
  }
}

function isMessage(value: unknown): value is { type: string; feedId?: string; url?: string; source?: string } {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
