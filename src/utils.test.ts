import { describe, it, expect } from "vitest";
import {
  resolvePath,
  getFullPath,
  extractRootName,
  filterAndSortEntries,
  classifyLink,
  parseMarkdownHref,
  findReadme,
  mergeRecent,
} from "./utils";
import type { RecentEntry } from "./utils";

describe("resolvePath", () => {
  it("resolves a simple relative path", () => {
    expect(resolvePath(["docs"], "guide.md")).toBe("docs/guide.md");
  });

  it("resolves parent directory traversal", () => {
    expect(resolvePath(["docs", "api"], "../guide.md")).toBe("docs/guide.md");
  });

  it("resolves multiple parent traversals", () => {
    expect(resolvePath(["a", "b", "c"], "../../d.md")).toBe("a/d.md");
  });

  it("ignores current directory segments", () => {
    expect(resolvePath(["docs"], "./guide.md")).toBe("docs/guide.md");
  });

  it("ignores empty segments", () => {
    expect(resolvePath(["docs"], "sub//file.md")).toBe("docs/sub/file.md");
  });

  it("resolves from empty base", () => {
    expect(resolvePath([], "docs/guide.md")).toBe("docs/guide.md");
  });

  it("resolves deeply nested relative path", () => {
    expect(resolvePath(["a", "b"], "c/d/e.md")).toBe("a/b/c/d/e.md");
  });

  it("handles parent traversal beyond root gracefully", () => {
    expect(resolvePath(["a"], "../../b.md")).toBe("b.md");
  });
});

describe("getFullPath", () => {
  it("returns root path when parts are empty", () => {
    expect(getFullPath("/Users/me/docs", [])).toBe("/Users/me/docs");
  });

  it("joins root path with path parts", () => {
    expect(getFullPath("/Users/me/docs", ["sub", "folder"])).toBe(
      "/Users/me/docs/sub/folder"
    );
  });

  it("joins single part", () => {
    expect(getFullPath("/root", ["child"])).toBe("/root/child");
  });
});

describe("extractRootName", () => {
  it("extracts the last segment of a path", () => {
    expect(extractRootName("/Users/me/docs")).toBe("docs");
  });

  it("returns root for empty path", () => {
    expect(extractRootName("")).toBe("root");
  });

  it("handles single segment", () => {
    expect(extractRootName("myFolder")).toBe("myFolder");
  });

  it("handles trailing slash", () => {
    expect(extractRootName("/a/b/c/")).toBe("root");
  });
});

describe("filterAndSortEntries", () => {
  it("filters dotfiles", () => {
    const result = filterAndSortEntries([
      { name: ".hidden", isDirectory: false },
      { name: "visible.md", isDirectory: false },
    ]);
    expect(result).toEqual([{ name: "visible.md", kind: "file" }]);
  });

  it("filters non-md files", () => {
    const result = filterAndSortEntries([
      { name: "readme.md", isDirectory: false },
      { name: "image.png", isDirectory: false },
      { name: "data.json", isDirectory: false },
    ]);
    expect(result).toEqual([{ name: "readme.md", kind: "file" }]);
  });

  it("sorts directories before files", () => {
    const result = filterAndSortEntries([
      { name: "zebra.md", isDirectory: false },
      { name: "alpha", isDirectory: true },
      { name: "apple.md", isDirectory: false },
      { name: "beta", isDirectory: true },
    ]);
    expect(result).toEqual([
      { name: "alpha", kind: "directory" },
      { name: "beta", kind: "directory" },
      { name: "apple.md", kind: "file" },
      { name: "zebra.md", kind: "file" },
    ]);
  });

  it("sorts directories alphabetically", () => {
    const result = filterAndSortEntries([
      { name: "charlie", isDirectory: true },
      { name: "alpha", isDirectory: true },
      { name: "bravo", isDirectory: true },
    ]);
    expect(result.map((e) => e.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("sorts files alphabetically", () => {
    const result = filterAndSortEntries([
      { name: "c.md", isDirectory: false },
      { name: "a.md", isDirectory: false },
      { name: "b.md", isDirectory: false },
    ]);
    expect(result.map((e) => e.name)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("skips entries with undefined name", () => {
    const result = filterAndSortEntries([
      { name: undefined, isDirectory: false },
      { name: "ok.md", isDirectory: false },
    ]);
    expect(result).toEqual([{ name: "ok.md", kind: "file" }]);
  });

  it("returns empty array for empty input", () => {
    expect(filterAndSortEntries([])).toEqual([]);
  });
});

describe("classifyLink", () => {
  it("classifies http links as external", () => {
    expect(classifyLink("http://example.com")).toBe("external");
  });

  it("classifies https links as external", () => {
    expect(classifyLink("https://example.com/page")).toBe("external");
  });

  it("classifies hash-only links as anchor", () => {
    expect(classifyLink("#section")).toBe("anchor");
  });

  it("classifies .md links as markdown", () => {
    expect(classifyLink("guide.md")).toBe("markdown");
  });

  it("classifies .md links with anchors as markdown", () => {
    expect(classifyLink("guide.md#section")).toBe("markdown");
  });

  it("classifies relative .md paths as markdown", () => {
    expect(classifyLink("../docs/guide.md")).toBe("markdown");
  });

  it("classifies other links as other", () => {
    expect(classifyLink("image.png")).toBe("other");
  });

  it("classifies root-relative links as other", () => {
    expect(classifyLink("/page")).toBe("other");
  });
});

describe("parseMarkdownHref", () => {
  it("parses a simple markdown link", () => {
    expect(parseMarkdownHref("guide.md")).toEqual({
      filePart: "guide.md",
      anchor: undefined,
    });
  });

  it("parses a markdown link with anchor", () => {
    expect(parseMarkdownHref("guide.md#section")).toEqual({
      filePart: "guide.md",
      anchor: "section",
    });
  });

  it("parses a relative markdown link with anchor", () => {
    expect(parseMarkdownHref("../docs/api.md#method")).toEqual({
      filePart: "../docs/api.md",
      anchor: "method",
    });
  });
});

describe("findReadme", () => {
  it("finds README.md (exact case)", () => {
    const entries = [
      { name: "docs", kind: "directory" as const },
      { name: "README.md", kind: "file" as const },
      { name: "guide.md", kind: "file" as const },
    ];
    expect(findReadme(entries)).toEqual({ name: "README.md", kind: "file" });
  });

  it("finds readme.md (lowercase)", () => {
    const entries = [{ name: "readme.md", kind: "file" as const }];
    expect(findReadme(entries)).toEqual({ name: "readme.md", kind: "file" });
  });

  it("finds Readme.md (mixed case)", () => {
    const entries = [{ name: "Readme.md", kind: "file" as const }];
    expect(findReadme(entries)).toEqual({ name: "Readme.md", kind: "file" });
  });

  it("returns undefined when no readme exists", () => {
    const entries = [
      { name: "guide.md", kind: "file" as const },
      { name: "docs", kind: "directory" as const },
    ];
    expect(findReadme(entries)).toBeUndefined();
  });

  it("ignores directories named readme.md", () => {
    const entries = [{ name: "readme.md", kind: "directory" as const }];
    expect(findReadme(entries)).toBeUndefined();
  });
});

describe("mergeRecent", () => {
  const f = (path: string): RecentEntry => ({ path, kind: "file" });

  it("prepends the new entry", () => {
    expect(mergeRecent([f("/a"), f("/b")], f("/c"), 10)).toEqual([
      f("/c"),
      f("/a"),
      f("/b"),
    ]);
  });

  it("moves an existing path to the front without duplicating", () => {
    expect(mergeRecent([f("/a"), f("/b"), f("/c")], f("/c"), 10)).toEqual([
      f("/c"),
      f("/a"),
      f("/b"),
    ]);
  });

  it("caps the list at max, dropping the oldest", () => {
    const result = mergeRecent([f("/a"), f("/b"), f("/c")], f("/d"), 3);
    expect(result).toEqual([f("/d"), f("/a"), f("/b")]);
  });

  it("dedupes by path regardless of kind", () => {
    const folder: RecentEntry = { path: "/a", kind: "folder" };
    expect(mergeRecent([f("/a")], folder, 10)).toEqual([folder]);
  });

  it("does not mutate the input list", () => {
    const list = [f("/a")];
    mergeRecent(list, f("/b"), 10);
    expect(list).toEqual([f("/a")]);
  });
});
