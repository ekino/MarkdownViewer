import { describe, it, expect } from "vitest";
import {
  computeAutoId,
  restoreSnapshotOnto,
  slugifyId,
  toHexForPicker,
  uniqueId,
  VAR_META,
} from "./theme-editor";
import { REQUIRED_VAR_KEYS } from "./themes";

describe("VAR_META", () => {
  it("covers every required CSS variable, exactly once", () => {
    const metaKeys = VAR_META.map((m) => m.key).sort();
    const expected = [...REQUIRED_VAR_KEYS].sort();
    expect(metaKeys).toEqual(expected);
  });

  it("every entry has a non-empty translation key", () => {
    for (const m of VAR_META) {
      expect(m.labelKey.length).toBeGreaterThan(0);
    }
  });
});

describe("slugifyId", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(slugifyId("My Cool Theme")).toBe("my-cool-theme");
  });

  it("strips diacritics", () => {
    expect(slugifyId("Café Noir")).toBe("cafe-noir");
  });

  it("collapses non-alphanumerics into a single dash", () => {
    expect(slugifyId("Hello !!! World")).toBe("hello-world");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugifyId("---abc---")).toBe("abc");
  });

  it("clamps length to 40", () => {
    expect(slugifyId("a".repeat(60)).length).toBeLessThanOrEqual(40);
  });

  it("returns 'theme' for empty / all-symbol input", () => {
    expect(slugifyId("")).toBe("theme");
    expect(slugifyId("!!!")).toBe("theme");
    expect(slugifyId("   ")).toBe("theme");
  });
});

describe("uniqueId", () => {
  it("returns base unchanged when not in the set", () => {
    expect(uniqueId("foo", new Set())).toBe("foo");
  });

  it("appends -2 on first collision", () => {
    expect(uniqueId("foo", new Set(["foo"]))).toBe("foo-2");
  });

  it("finds the next free integer suffix", () => {
    expect(uniqueId("foo", new Set(["foo", "foo-2", "foo-3"]))).toBe("foo-4");
  });
});

describe("toHexForPicker", () => {
  it("returns the same 6-digit hex (lowercased)", () => {
    expect(toHexForPicker("#FFAA00")).toBe("#ffaa00");
    expect(toHexForPicker("#000000")).toBe("#000000");
  });

  it("expands 3-digit hex shorthand", () => {
    expect(toHexForPicker("#fa0")).toBe("#ffaa00");
    expect(toHexForPicker("#000")).toBe("#000000");
  });

  it("returns null for empty/whitespace input", () => {
    expect(toHexForPicker("")).toBeNull();
    expect(toHexForPicker("   ")).toBeNull();
  });

  it("parses rgb() values via the DOM", () => {
    expect(toHexForPicker("rgb(255, 170, 0)")).toBe("#ffaa00");
    expect(toHexForPicker("rgb(0, 0, 0)")).toBe("#000000");
  });

  it("parses CSS named colors", () => {
    expect(toHexForPicker("tomato")).toBe("#ff6347");
    expect(toHexForPicker("rebeccapurple")).toBe("#663399");
  });

  it("returns null for invalid syntax", () => {
    expect(toHexForPicker("not-a-color")).toBeNull();
    expect(toHexForPicker("#zz")).toBeNull();
  });
});

describe("computeAutoId — id derived from name", () => {
  it("returns the slug of the name when nothing is taken", () => {
    expect(computeAutoId("My New Theme", new Set())).toBe("my-new-theme");
  });

  it("suffixes -2 when the slug is already taken", () => {
    expect(
      computeAutoId("My New Theme", new Set(["my-new-theme"]))
    ).toBe("my-new-theme-2");
  });

  it("walks suffixes until a free one is found", () => {
    expect(
      computeAutoId(
        "My New Theme",
        new Set(["my-new-theme", "my-new-theme-2", "my-new-theme-3"])
      )
    ).toBe("my-new-theme-4");
  });

  it("strips diacritics like slugifyId does", () => {
    expect(computeAutoId("Café Noir", new Set())).toBe("cafe-noir");
  });

  it("falls back to 'theme' when the name yields no usable slug", () => {
    expect(computeAutoId("", new Set())).toBe("theme");
    expect(computeAutoId("!!!", new Set())).toBe("theme");
  });

  it("with originalId provided, the editor's own id does not count as taken", () => {
    // Editing in place: name still resolves to the original slug → keep id stable.
    expect(
      computeAutoId("My Theme", new Set(["my-theme", "other"]), "my-theme")
    ).toBe("my-theme");
  });

  it("with originalId, a name change to a free slug yields the new slug", () => {
    expect(
      computeAutoId("Brand New", new Set(["my-theme"]), "my-theme")
    ).toBe("brand-new");
  });

  it("with originalId, a name change to an already-taken slug gets a suffix", () => {
    expect(
      computeAutoId(
        "Dracula",
        new Set(["my-theme", "dracula"]),
        "my-theme"
      )
    ).toBe("dracula-2");
  });

  it("originalId does not need to be in the taken set to be excluded", () => {
    // Defensive: the caller may pre-filter, but the helper still works.
    expect(
      computeAutoId("Anything", new Set(), "stale-original-id")
    ).toBe("anything");
  });
});

describe("restoreSnapshotOnto — editor preview rollback", () => {
  it("restores previously-set inline values", () => {
    const root = document.createElement("div");
    root.style.setProperty("--a", "modified");
    restoreSnapshotOnto(
      root,
      { "--a": "original" },
      ["--a"]
    );
    expect(root.style.getPropertyValue("--a")).toBe("original");
  });

  it("removes the inline property when the snapshot value was empty", () => {
    // Reproduces the bug: a variable that was not set inline before the
    // editor opened must be cleared on rollback, otherwise the preview
    // value stays applied.
    const root = document.createElement("div");
    root.style.setProperty("--a", "preview-value");
    restoreSnapshotOnto(root, { "--a": "" }, ["--a"]);
    expect(root.style.getPropertyValue("--a")).toBe("");
  });

  it("treats a missing key in the snapshot like an empty value (clears it)", () => {
    const root = document.createElement("div");
    root.style.setProperty("--a", "preview-value");
    restoreSnapshotOnto(root, {}, ["--a"]);
    expect(root.style.getPropertyValue("--a")).toBe("");
  });

  it("handles a mix of set and unset variables in one call", () => {
    const root = document.createElement("div");
    root.style.setProperty("--a", "preview-a");
    root.style.setProperty("--b", "preview-b");
    restoreSnapshotOnto(
      root,
      { "--a": "original-a", "--b": "" },
      ["--a", "--b"]
    );
    expect(root.style.getPropertyValue("--a")).toBe("original-a");
    expect(root.style.getPropertyValue("--b")).toBe("");
  });

  it("only touches the keys provided", () => {
    const root = document.createElement("div");
    root.style.setProperty("--a", "touched");
    root.style.setProperty("--other", "left-alone");
    restoreSnapshotOnto(root, { "--a": "ok" }, ["--a"]);
    expect(root.style.getPropertyValue("--other")).toBe("left-alone");
  });
});
