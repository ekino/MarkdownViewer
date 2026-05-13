import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRecentsList, showContextMenu } from "./welcome";
import type { RecentEntry } from "./recents";

afterEach(() => {
  document.body.innerHTML = "";
});

const entry = (overrides: Partial<RecentEntry> = {}): RecentEntry => ({
  kind: "file",
  path: "/Users/foo/doc.md",
  displayName: "doc.md",
  lastOpenedAt: 1,
  ...overrides,
});

describe("renderRecentsList", () => {
  it("renders one item per entry with displayName, path, and kind", () => {
    const ul = document.createElement("ul");
    renderRecentsList(
      ul,
      [
        { ...entry({ path: "/Users/foo/doc.md" }), missing: false },
        {
          ...entry({ kind: "folder", path: "/Users/foo/docs", displayName: "docs" }),
          missing: false,
        },
      ],
      {
        onOpenRecent: vi.fn(),
        onReveal: vi.fn(),
        onRemove: vi.fn(),
        onClear: vi.fn(),
      },
    );
    const items = ul.querySelectorAll(".welcome-recent-item");
    expect(items.length).toBe(2);
    expect(items[0].querySelector(".name")?.textContent).toBe("doc.md");
    expect(items[0].querySelector(".path")?.textContent).toBe("/Users/foo");
    expect(items[0].querySelector(".kind")?.textContent).toBe("FILE");
    expect(items[1].querySelector(".path")?.textContent).toBe("/Users/foo/docs");
    expect(items[1].querySelector(".kind")?.textContent).toBe("FOLDER");
  });

  it("applies the missing class and disables click open for missing entries (click still fires onOpenRecent — caller decides)", () => {
    const ul = document.createElement("ul");
    const onOpenRecent = vi.fn();
    renderRecentsList(
      ul,
      [{ ...entry(), missing: true }],
      {
        onOpenRecent,
        onReveal: vi.fn(),
        onRemove: vi.fn(),
        onClear: vi.fn(),
      },
    );
    const item = ul.querySelector(".welcome-recent-item") as HTMLLIElement;
    expect(item.classList.contains("missing")).toBe(true);
  });

  it("fires onOpenRecent when clicked", () => {
    const ul = document.createElement("ul");
    const onOpenRecent = vi.fn();
    renderRecentsList(
      ul,
      [{ ...entry(), missing: false }],
      {
        onOpenRecent,
        onReveal: vi.fn(),
        onRemove: vi.fn(),
        onClear: vi.fn(),
      },
    );
    const item = ul.querySelector(".welcome-recent-item") as HTMLLIElement;
    item.click();
    expect(onOpenRecent).toHaveBeenCalledTimes(1);
  });

  it("clears previous content on re-render", () => {
    const ul = document.createElement("ul");
    const handlers = {
      onOpenRecent: vi.fn(),
      onReveal: vi.fn(),
      onRemove: vi.fn(),
      onClear: vi.fn(),
    };
    renderRecentsList(ul, [{ ...entry(), missing: false }], handlers);
    renderRecentsList(ul, [], handlers);
    expect(ul.children.length).toBe(0);
  });
});

describe("showContextMenu", () => {
  it("inserts a .ctx-menu with one button per item", () => {
    showContextMenu(10, 10, [
      { label: "A", onSelect: vi.fn() },
      { label: "B", onSelect: vi.fn() },
    ]);
    const menu = document.querySelector(".ctx-menu");
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll("button").length).toBe(2);
  });

  it("removes any prior menu before opening a new one", () => {
    showContextMenu(10, 10, [{ label: "First", onSelect: vi.fn() }]);
    showContextMenu(20, 20, [{ label: "Second", onSelect: vi.fn() }]);
    const menus = document.querySelectorAll(".ctx-menu");
    expect(menus.length).toBe(1);
    expect(menus[0].textContent).toContain("Second");
  });

  it("calls onSelect when an item is clicked and removes itself", () => {
    const onSelect = vi.fn();
    showContextMenu(10, 10, [{ label: "Pick", onSelect }]);
    const btn = document.querySelector(".ctx-menu button") as HTMLButtonElement;
    btn.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });
});
