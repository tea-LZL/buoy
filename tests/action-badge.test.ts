import { describe, expect, it } from "vitest";
import { applyActionBadge, BADGE_BACKGROUND, unreadBadgeText } from "../src/lib/action-badge";

function fakeAction() {
  const badgeTexts: Array<{ text: string; tabId?: number }> = [];
  const backgroundColors: string[] = [];
  return {
    badgeTexts,
    backgroundColors,
    setBadgeBackgroundColor: async (details: { color: string }) => {
      backgroundColors.push(details.color);
    },
    setBadgeText: async (details: { text: string; tabId?: number }) => {
      badgeTexts.push({ text: details.text, tabId: details.tabId });
    }
  };
}

describe("unreadBadgeText", () => {
  it("clears the badge when there are no unread posts", () => {
    expect(unreadBadgeText(0)).toBe("");
  });

  it("shows the unread count up to 99", () => {
    expect(unreadBadgeText(5)).toBe("5");
    expect(unreadBadgeText(99)).toBe("99");
  });

  it("caps counts above 99", () => {
    expect(unreadBadgeText(100)).toBe("99+");
  });
});

describe("applyActionBadge", () => {
  it("sets the global badge and every open tab so Firefox does not keep a stale pip", async () => {
    const action = fakeAction();
    const tabs = {
      query: async () => [{ id: 1 }, { id: 2 }, { id: undefined }]
    };

    await applyActionBadge(unreadBadgeText(5), action, tabs);

    expect(action.backgroundColors).toEqual([BADGE_BACKGROUND]);
    expect(action.badgeTexts).toEqual([
      { text: "5" },
      { text: "5", tabId: 1 },
      { text: "5", tabId: 2 }
    ]);
  });

  it("clears the global badge and every open tab when nothing is unread", async () => {
    const action = fakeAction();
    const tabs = {
      query: async () => [{ id: 7 }, { id: 8 }]
    };

    await applyActionBadge(unreadBadgeText(0), action, tabs);

    expect(action.badgeTexts).toEqual([
      { text: "" },
      { text: "", tabId: 7 },
      { text: "", tabId: 8 }
    ]);
  });

  it("still applies remaining tabs if one tab closes during the update", async () => {
    const action = fakeAction();
    action.setBadgeText = async (details: { text: string; tabId?: number }) => {
      if (details.tabId === 2) throw new Error("Invalid tab ID");
      action.badgeTexts.push({ text: details.text, tabId: details.tabId });
    };
    const tabs = {
      query: async () => [{ id: 1 }, { id: 2 }, { id: 3 }]
    };

    await expect(applyActionBadge("1", action, tabs)).resolves.toBeUndefined();
    expect(action.badgeTexts).toEqual([
      { text: "1" },
      { text: "1", tabId: 1 },
      { text: "1", tabId: 3 }
    ]);
  });
});
