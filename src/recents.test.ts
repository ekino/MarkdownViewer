import { describe, expect, it } from "vitest";
import {
  MAX_RECENTS,
  RECENTS_KEY,
  clearRecents,
  isValidRecent,
  loadRecents,
  pushRecent,
  saveRecents,
  sanitizeRecents,
  type RecentEntry,
  type StoreLike,
} from "./recents";

function makeStore(initial: Record<string, unknown> = {}): StoreLike & {
  data: Record<string, unknown>;
  saves: number;
} {
  const data = { ...initial };
  let saves = 0;
  return {
    data,
    get saves() {
      return saves;
    },
    async get<T>(key: string) {
      return data[key] as T | undefined;
    },
    async set(key: string, value: unknown) {
      data[key] = value;
    },
    async save() {
      saves++;
    },
  };
}

const sample = (
  overrides: Partial<RecentEntry> = {},
): RecentEntry => ({
  kind: "file",
  path: "/tmp/a.md",
  displayName: "a.md",
  lastOpenedAt: 1,
  ...overrides,
});

describe("isValidRecent", () => {
  it("accepts well-formed entries", () => {
    expect(isValidRecent(sample())).toBe(true);
    expect(isValidRecent(sample({ kind: "folder", path: "/tmp" }))).toBe(true);
  });

  it("rejects bad shapes", () => {
    expect(isValidRecent(null)).toBe(false);
    expect(isValidRecent({})).toBe(false);
    expect(isValidRecent({ ...sample(), kind: "weird" })).toBe(false);
    expect(isValidRecent({ ...sample(), path: "" })).toBe(false);
    expect(isValidRecent({ ...sample(), lastOpenedAt: "now" })).toBe(false);
    expect(isValidRecent({ ...sample(), lastOpenedAt: Number.NaN })).toBe(false);
  });

  it("rejects paths longer than 4096 chars", () => {
    expect(isValidRecent(sample({ path: "/".repeat(4097) }))).toBe(false);
  });
});

describe("sanitizeRecents", () => {
  it("drops malformed entries and dedupes by kind+path", () => {
    const raw = [
      sample({ path: "/a.md" }),
      sample({ path: "/a.md", lastOpenedAt: 2 }), // dup
      { kind: "file", path: 42 }, // bad
      sample({ kind: "folder", path: "/a.md" }), // diff kind, kept
    ];
    const out = sanitizeRecents(raw);
    expect(out.map((r) => `${r.kind}:${r.path}`)).toEqual([
      "file:/a.md",
      "folder:/a.md",
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeRecents(null)).toEqual([]);
    expect(sanitizeRecents("nope")).toEqual([]);
  });

  it("caps at MAX_RECENTS", () => {
    const raw = Array.from({ length: MAX_RECENTS + 5 }, (_, i) =>
      sample({ path: `/f${i}.md` }),
    );
    expect(sanitizeRecents(raw)).toHaveLength(MAX_RECENTS);
  });
});

describe("pushRecent", () => {
  it("prepends new entries", () => {
    const cur = [sample({ path: "/a.md" })];
    const next = pushRecent(cur, sample({ path: "/b.md", lastOpenedAt: 2 }));
    expect(next.map((r) => r.path)).toEqual(["/b.md", "/a.md"]);
  });

  it("dedupes by kind+path and moves to front with new timestamp", () => {
    const cur = [
      sample({ path: "/a.md", lastOpenedAt: 1 }),
      sample({ path: "/b.md", lastOpenedAt: 2 }),
    ];
    const next = pushRecent(cur, sample({ path: "/a.md", lastOpenedAt: 9 }));
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ path: "/a.md", lastOpenedAt: 9 });
    expect(next[1]).toMatchObject({ path: "/b.md" });
  });

  it("respects MAX_RECENTS cap when pushing", () => {
    const cur = Array.from({ length: MAX_RECENTS }, (_, i) =>
      sample({ path: `/f${i}.md` }),
    );
    const next = pushRecent(cur, sample({ path: "/new.md" }));
    expect(next).toHaveLength(MAX_RECENTS);
    expect(next[0].path).toBe("/new.md");
    // The oldest (last) entry should have been evicted.
    expect(next.find((r) => r.path === `/f${MAX_RECENTS - 1}.md`)).toBeUndefined();
  });

  it("returns a copy untouched when entry is invalid", () => {
    const cur = [sample()];
    const next = pushRecent(cur, { kind: "bad" } as unknown as RecentEntry);
    expect(next).toEqual(cur);
    expect(next).not.toBe(cur);
  });
});

describe("clearRecents", () => {
  it("returns an empty array", () => {
    expect(clearRecents()).toEqual([]);
  });
});

describe("load/saveRecents", () => {
  it("round-trips through a store", async () => {
    const store = makeStore();
    await saveRecents(store, [sample()]);
    expect(store.data[RECENTS_KEY]).toEqual([sample()]);
    expect(store.saves).toBe(1);
    const out = await loadRecents(store);
    expect(out).toEqual([sample()]);
  });

  it("sanitizes when loading", async () => {
    const store = makeStore({
      [RECENTS_KEY]: [sample(), { bogus: true }, sample({ path: "/b.md" })],
    });
    const out = await loadRecents(store);
    expect(out.map((r) => r.path)).toEqual(["/tmp/a.md", "/b.md"]);
  });

  it("truncates to MAX_RECENTS on save", async () => {
    const store = makeStore();
    const big = Array.from({ length: MAX_RECENTS + 3 }, (_, i) =>
      sample({ path: `/f${i}.md` }),
    );
    await saveRecents(store, big);
    expect((store.data[RECENTS_KEY] as RecentEntry[]).length).toBe(MAX_RECENTS);
  });
});
