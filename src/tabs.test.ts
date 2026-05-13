import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabManager } from "./tabs";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.innerHTML = "";
});

function makeManager(opts?: { maxTabs?: number }) {
  const handlers = {
    onActivate: vi.fn(),
    onChange: vi.fn(),
    onEmpty: vi.fn(),
  };
  const m = new TabManager(container, handlers, opts);
  return { m, handlers };
}

describe("TabManager.openInNewTab", () => {
  it("creates a tab and activates it", async () => {
    const { m, handlers } = makeManager();
    await m.openInNewTab("/a/foo.md");
    const state = m.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].filePath).toBe("/a/foo.md");
    expect(state.tabs[0].title).toBe("foo");
    expect(state.activeId).toBe(state.tabs[0].id);
    expect(handlers.onActivate).toHaveBeenCalledWith("/a/foo.md", 0);
  });

  it("activates the existing tab when the same path is opened twice", async () => {
    const { m } = makeManager();
    const id = await m.openInNewTab("/a/foo.md");
    await m.openInNewTab("/a/bar.md");
    const again = await m.openInNewTab("/a/foo.md");
    expect(again).toBe(id);
    expect(m.getState().tabs).toHaveLength(2);
    expect(m.getState().activeId).toBe(id);
  });

  it("evicts the oldest non-active tab when maxTabs is reached", async () => {
    const { m } = makeManager({ maxTabs: 3 });
    await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    await m.openInNewTab("/c.md"); // active
    await m.openInNewTab("/d.md");
    const paths = m.getState().tabs.map((t) => t.filePath);
    expect(paths).toHaveLength(3);
    expect(paths).not.toContain("/a.md");
    expect(paths).toContain("/c.md");
    expect(paths).toContain("/d.md");
  });
});

describe("TabManager.openInActiveTab", () => {
  it("replaces the active tab's file when nothing matches", async () => {
    const { m, handlers } = makeManager();
    await m.openInNewTab("/a.md");
    handlers.onActivate.mockClear();
    await m.openInActiveTab("/b.md");
    const tabs = m.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].filePath).toBe("/b.md");
    expect(handlers.onActivate).toHaveBeenCalledWith("/b.md", 0);
  });

  it("activates the matching existing tab without duplicating", async () => {
    const { m } = makeManager();
    await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    await m.openInActiveTab("/a.md");
    const state = m.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe(state.tabs[0].id);
  });

  it("falls back to openInNewTab when no tab is active", async () => {
    const { m } = makeManager();
    await m.openInActiveTab("/a.md");
    expect(m.getState().tabs).toHaveLength(1);
  });
});

describe("TabManager.closeTab", () => {
  it("activates the right neighbour after closing the active tab", async () => {
    const { m, handlers } = makeManager();
    await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    await m.openInNewTab("/c.md"); // active
    handlers.onActivate.mockClear();
    const cId = m.getState().activeId!;
    await m.closeTab(cId);
    // After closing /c.md (rightmost), neighbour to its left becomes active.
    expect(m.getState().tabs.map((t) => t.filePath)).toEqual(["/a.md", "/b.md"]);
    expect(handlers.onActivate).toHaveBeenCalledWith("/b.md", 0);
  });

  it("fires onEmpty when the last tab is closed", async () => {
    const { m, handlers } = makeManager();
    const id = await m.openInNewTab("/only.md");
    await m.closeTab(id);
    expect(m.getState().tabs).toHaveLength(0);
    expect(m.getState().activeId).toBeNull();
    expect(handlers.onEmpty).toHaveBeenCalled();
  });

  it("leaves the active tab alone when closing a different one", async () => {
    const { m } = makeManager();
    const a = await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md"); // becomes active
    await m.closeTab(a);
    expect(m.getState().tabs.map((t) => t.filePath)).toEqual(["/b.md"]);
  });
});

describe("TabManager.cycle and jumpTo", () => {
  it("cycle(+1) moves to the next tab and wraps", async () => {
    const { m } = makeManager();
    await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    await m.openInNewTab("/c.md"); // active
    m.cycle(1);
    expect(m.getState().tabs.find((t) => t.id === m.getState().activeId)?.filePath).toBe(
      "/a.md",
    );
  });

  it("cycle(-1) moves backwards", async () => {
    const { m } = makeManager();
    await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    await m.openInNewTab("/c.md");
    m.cycle(-1);
    const active = m.getState().tabs.find((t) => t.id === m.getState().activeId);
    expect(active?.filePath).toBe("/b.md");
  });

  it("jumpTo(n) is 1-indexed and ignores out-of-range", async () => {
    const { m } = makeManager();
    await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    m.jumpTo(1);
    expect(m.getState().tabs.find((t) => t.id === m.getState().activeId)?.filePath).toBe(
      "/a.md",
    );
    m.jumpTo(99); // no-op
    expect(m.getState().tabs.find((t) => t.id === m.getState().activeId)?.filePath).toBe(
      "/a.md",
    );
  });
});

describe("TabManager.captureScrollOfActive", () => {
  it("stores the scroll position on the active tab", async () => {
    const { m } = makeManager();
    await m.openInNewTab("/a.md");
    m.captureScrollOfActive(1234);
    expect(m.getState().tabs[0].scrollY).toBe(1234);
  });

  it("restores the captured scroll on next activation", async () => {
    const { m, handlers } = makeManager();
    await m.openInNewTab("/a.md");
    m.captureScrollOfActive(500);
    await m.openInNewTab("/b.md");
    handlers.onActivate.mockClear();
    await m.activate(m.getState().tabs[0].id);
    expect(handlers.onActivate).toHaveBeenCalledWith("/a.md", 500);
  });
});

describe("TabManager.restore", () => {
  it("rehydrates without firing onActivate (host owns load sequencing)", async () => {
    const { m, handlers } = makeManager();
    await m.restore(
      [
        { id: "x1", filePath: "/a.md", title: "a", scrollY: 0 },
        { id: "x2", filePath: "/b.md", title: "b", scrollY: 200 },
      ],
      "x2",
    );
    expect(m.getState().tabs).toHaveLength(2);
    expect(m.getState().activeId).toBe("x2");
    expect(handlers.onActivate).not.toHaveBeenCalled();
  });

  it("falls back to the first tab when activeId doesn't match", async () => {
    const { m } = makeManager();
    await m.restore(
      [{ id: "x1", filePath: "/a.md", title: "a", scrollY: 0 }],
      "missing",
    );
    expect(m.getState().activeId).toBe("x1");
  });
});

describe("TabManager DOM rendering", () => {
  it("renders one pill per tab with the active class on the active one", async () => {
    const { m } = makeManager();
    await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    const pills = container.querySelectorAll(".tab-pill");
    expect(pills.length).toBe(2);
    const active = container.querySelector(".tab-pill.active");
    expect(active?.textContent).toContain("b");
  });

  it("close button on a pill closes only that tab", async () => {
    const { m } = makeManager();
    const aId = await m.openInNewTab("/a.md");
    await m.openInNewTab("/b.md");
    const aPill = container.querySelector(
      `.tab-pill[data-tab-id="${aId}"]`,
    ) as HTMLElement;
    (aPill.querySelector(".tab-close") as HTMLElement).click();
    // closeTab is async; let the microtask flush.
    await Promise.resolve();
    expect(m.getState().tabs.map((t) => t.filePath)).toEqual(["/b.md"]);
  });

  it("hides the container when there are no tabs", async () => {
    const { m } = makeManager();
    expect(container.hidden).toBe(false); // never rendered yet
    const id = await m.openInNewTab("/a.md");
    expect(container.hidden).toBe(false);
    await m.closeTab(id);
    expect(container.hidden).toBe(true);
  });
});
