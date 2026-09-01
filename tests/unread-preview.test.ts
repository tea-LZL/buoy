import { describe, expect, it } from "vitest";
import { shouldAnimateUnreadRemoval, shouldDeferUnreadReload } from "../src/reader/unread-preview";

describe("unread preview state", () => {
  it("defers background unread reloads until preview closes and its row finishes leaving", () => {
    expect(shouldDeferUnreadReload("unread", { read: true })).toBe(true);
    expect(shouldDeferUnreadReload("unread", undefined, "entry-1")).toBe(true);
    expect(shouldDeferUnreadReload("unread")).toBe(false);
    expect(shouldDeferUnreadReload("all", { read: true })).toBe(false);
  });

  it("animates removal only for read posts in unread view", () => {
    expect(shouldAnimateUnreadRemoval("unread", { read: true })).toBe(true);
    expect(shouldAnimateUnreadRemoval("unread", { read: false })).toBe(false);
    expect(shouldAnimateUnreadRemoval("all", { read: true })).toBe(false);
  });
});
