import type { Entry } from "../types";

export type ReaderView = "all" | "unread";

export function shouldDeferUnreadReload(view: ReaderView, activeEntry?: Pick<Entry, "read">, removingEntryId?: string): boolean {
  return view === "unread" && Boolean(activeEntry || removingEntryId);
}

export function shouldAnimateUnreadRemoval(view: ReaderView, entry?: Pick<Entry, "read">): boolean {
  return view === "unread" && Boolean(entry?.read);
}
