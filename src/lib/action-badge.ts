export const BADGE_BACKGROUND = "#fa5b85";

interface ActionBadgeApi {
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
}

interface TabsQueryApi {
  query(queryInfo: Record<string, never>): Promise<Array<{ id?: number }>>;
}

export function unreadBadgeText(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

export async function applyActionBadge(
  text: string,
  action: ActionBadgeApi,
  tabs: TabsQueryApi
): Promise<void> {
  await action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND });
  await action.setBadgeText({ text });

  const openTabs = await tabs.query({});
  await Promise.all(
    openTabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await action.setBadgeText({ text, tabId: tab.id });
      } catch {
        // Tab closed between query and update.
      }
    })
  );
}
