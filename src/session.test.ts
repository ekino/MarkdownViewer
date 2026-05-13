import { describe, expect, it } from "vitest";
import {
  LEGACY_FOLDER_KEY,
  MAX_SESSION_TABS,
  SESSION_KEY,
  emptySession,
  loadSession,
  saveSession,
  sanitizeSession,
} from "./session";
import type { StoreLike } from "./recents";

function makeStore(initial: Record<string, unknown> = {}): StoreLike & {
  data: Record<string, unknown>;
} {
  const data = { ...initial };
  return {
    data,
    async get<T>(key: string) {
      return data[key] as T | undefined;
    },
    async set(key: string, value: unknown) {
      data[key] = value;
    },
    async save() {},
  };
}

describe("sanitizeSession", () => {
  it("returns empty session for junk", () => {
    expect(sanitizeSession(null)).toEqual(emptySession());
    expect(sanitizeSession("nope")).toEqual(emptySession());
    expect(sanitizeSession({})).toEqual(emptySession());
  });

  it("preserves valid folder + tabs + activeTabIndex", () => {
    const out = sanitizeSession({
      folder: "/tmp",
      tabs: [
        { filePath: "/tmp/a.md", scrollY: 120 },
        { filePath: "/tmp/b.md", scrollY: 0 },
      ],
      activeTabIndex: 1,
    });
    expect(out).toEqual({
      folder: "/tmp",
      tabs: [
        { filePath: "/tmp/a.md", scrollY: 120 },
        { filePath: "/tmp/b.md", scrollY: 0 },
      ],
      activeTabIndex: 1,
    });
  });

  it("drops malformed tabs", () => {
    const out = sanitizeSession({
      folder: "/tmp",
      tabs: [
        { filePath: "/tmp/a.md", scrollY: 50 },
        { filePath: 42, scrollY: 0 }, // bad
        { filePath: "/tmp/b.md", scrollY: "no" }, // bad
      ],
      activeTabIndex: 0,
    });
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0].filePath).toBe("/tmp/a.md");
  });

  it("clamps negative scrollY to 0", () => {
    const out = sanitizeSession({
      folder: "/tmp",
      tabs: [{ filePath: "/tmp/a.md", scrollY: -42 }],
      activeTabIndex: 0,
    });
    expect(out.tabs[0].scrollY).toBe(0);
  });

  it("migrates legacy scrollPercent entries to scrollY=0", () => {
    const out = sanitizeSession({
      folder: "/tmp",
      tabs: [{ filePath: "/tmp/a.md", scrollPercent: 0.7 }],
      activeTabIndex: 0,
    });
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0]).toEqual({ filePath: "/tmp/a.md", scrollY: 0 });
  });

  it("caps tabs at MAX_SESSION_TABS", () => {
    const tabs = Array.from({ length: MAX_SESSION_TABS + 5 }, (_, i) => ({
      filePath: `/tmp/${i}.md`,
      scrollY: 0,
    }));
    const out = sanitizeSession({ folder: "/tmp", tabs, activeTabIndex: 0 });
    expect(out.tabs).toHaveLength(MAX_SESSION_TABS);
  });

  it("repairs out-of-range activeTabIndex", () => {
    const out = sanitizeSession({
      folder: "/tmp",
      tabs: [{ filePath: "/a.md", scrollY: 0 }],
      activeTabIndex: 99,
    });
    expect(out.activeTabIndex).toBe(0);
  });

  it("treats empty folder as null", () => {
    expect(sanitizeSession({ folder: "" }).folder).toBeNull();
  });
});

describe("loadSession", () => {
  it("reads the session key when present", async () => {
    const store = makeStore({
      [SESSION_KEY]: { folder: "/tmp", tabs: [], activeTabIndex: -1 },
    });
    const out = await loadSession(store);
    expect(out.folder).toBe("/tmp");
  });

  it("falls back to legacy lastFolder when session key absent", async () => {
    const store = makeStore({ [LEGACY_FOLDER_KEY]: "/legacy" });
    const out = await loadSession(store);
    expect(out).toEqual({ folder: "/legacy", tabs: [], activeTabIndex: -1 });
  });

  it("returns empty session when nothing is stored", async () => {
    const store = makeStore();
    expect(await loadSession(store)).toEqual(emptySession());
  });

  it("prefers session over legacy when both exist", async () => {
    const store = makeStore({
      [SESSION_KEY]: { folder: "/new", tabs: [], activeTabIndex: -1 },
      [LEGACY_FOLDER_KEY]: "/old",
    });
    const out = await loadSession(store);
    expect(out.folder).toBe("/new");
  });
});

describe("saveSession", () => {
  it("persists a sanitized copy", async () => {
    const store = makeStore();
    await saveSession(store, {
      folder: "/tmp",
      tabs: [{ filePath: "/tmp/a.md", scrollY: -10 }],
      activeTabIndex: 0,
    });
    const stored = store.data[SESSION_KEY] as ReturnType<typeof sanitizeSession>;
    expect(stored.tabs[0].scrollY).toBe(0); // clamped
  });
});
