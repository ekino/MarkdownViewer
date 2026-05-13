import { describe, it, expect, beforeEach } from "vitest";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_ORDER,
  REQUIRED_VAR_KEYS,
  applyThemeToDOM,
  buildThemeCatalog,
  isTheme,
  isThemeId,
  isValidThemeId,
  mergeCustomThemes,
  parseTheme,
  resolveActiveThemeId,
  resolveInitialThemeId,
  sanitizeCustomThemes,
  VALID_THEME_ID_RE,
  type Theme,
} from "./themes";

function validThemeFixture(overrides: Partial<Theme> = {}): Theme {
  return {
    id: "custom1",
    name: "Custom 1",
    isDark: true,
    pair: "light",
    vars: { ...BUILTIN_THEMES.dark.vars },
    ...overrides,
  };
}

describe("BUILTIN_THEMES catalog", () => {
  it("has exactly the eight expected themes", () => {
    const ids = Object.keys(BUILTIN_THEMES).sort();
    expect(ids).toEqual(
      [
        "dark",
        "dracula",
        "github",
        "light",
        "nord",
        "sepia",
        "solarized-dark",
        "solarized-light",
      ].sort()
    );
  });

  it("BUILTIN_THEME_ORDER lists every theme exactly once", () => {
    const fromOrder = [...BUILTIN_THEME_ORDER].sort();
    const fromMap = Object.keys(BUILTIN_THEMES).sort();
    expect(fromOrder).toEqual(fromMap);
    expect(new Set(BUILTIN_THEME_ORDER).size).toBe(BUILTIN_THEME_ORDER.length);
  });

  it("each builtin theme passes isTheme()", () => {
    for (const theme of Object.values(BUILTIN_THEMES)) {
      expect(isTheme(theme), theme.id).toBe(true);
    }
  });

  it("each theme defines all required CSS variables", () => {
    for (const [id, theme] of Object.entries(BUILTIN_THEMES)) {
      for (const key of REQUIRED_VAR_KEYS) {
        const v = theme.vars[key];
        expect(v, `${id}.${key}`).toBeTruthy();
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      }
    }
  });

  it("each theme's pair points to a valid existing theme", () => {
    for (const theme of Object.values(BUILTIN_THEMES)) {
      expect(theme.pair in BUILTIN_THEMES).toBe(true);
    }
  });

  it("a theme's pair is never itself, and pairs have opposite isDark", () => {
    for (const theme of Object.values(BUILTIN_THEMES)) {
      expect(theme.pair).not.toBe(theme.id);
      const pair = BUILTIN_THEMES[theme.pair];
      expect(pair.isDark).toBe(!theme.isDark);
    }
  });
});

describe("isValidThemeId / VALID_THEME_ID_RE", () => {
  it("accepts lower/upper case letters, digits, dash and underscore", () => {
    expect(isValidThemeId("a")).toBe(true);
    expect(isValidThemeId("Z")).toBe(true);
    expect(isValidThemeId("0")).toBe(true);
    expect(isValidThemeId("foo-bar_baz-2")).toBe(true);
  });

  it("rejects empty string and non-strings", () => {
    expect(isValidThemeId("")).toBe(false);
    expect(isValidThemeId(null)).toBe(false);
    expect(isValidThemeId(undefined)).toBe(false);
    expect(isValidThemeId(42)).toBe(false);
  });

  it("rejects ids containing forbidden characters", () => {
    expect(isValidThemeId("foo bar")).toBe(false);
    expect(isValidThemeId("foo/bar")).toBe(false);
    expect(isValidThemeId("../evil")).toBe(false);
    expect(isValidThemeId("foo.bar")).toBe(false);
  });

  it("the regex itself is anchored and not exploitable via partial matches", () => {
    expect(VALID_THEME_ID_RE.test("ok")).toBe(true);
    expect(VALID_THEME_ID_RE.test("ok\nbad")).toBe(false);
    expect(VALID_THEME_ID_RE.test("ok bad")).toBe(false);
  });
});

describe("isTheme (validator)", () => {
  it("accepts a fully valid theme", () => {
    expect(isTheme(validThemeFixture())).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
    expect(isTheme("dark")).toBe(false);
    expect(isTheme(42)).toBe(false);
  });

  it("rejects missing/empty id", () => {
    expect(isTheme({ ...validThemeFixture(), id: "" })).toBe(false);
    const broken = { ...validThemeFixture() } as Record<string, unknown>;
    delete broken.id;
    expect(isTheme(broken)).toBe(false);
  });

  it("rejects ids that don't match the safe-character regex", () => {
    // Path-traversal sequences are the main concern; mirror Rust's
    // [A-Za-z0-9_-]+ constraint at the JS boundary.
    expect(isTheme({ ...validThemeFixture(), id: "../../evil" })).toBe(false);
    expect(isTheme({ ...validThemeFixture(), id: "with spaces" })).toBe(false);
    expect(isTheme({ ...validThemeFixture(), id: "with/slash" })).toBe(false);
    expect(isTheme({ ...validThemeFixture(), id: "with\\backslash" })).toBe(false);
    expect(isTheme({ ...validThemeFixture(), id: "café" })).toBe(false);
    expect(isTheme({ ...validThemeFixture(), id: "dot.in.id" })).toBe(false);
    expect(isTheme({ ...validThemeFixture(), id: "with:colon" })).toBe(false);
  });

  it("accepts ids matching [A-Za-z0-9_-]+", () => {
    expect(isTheme({ ...validThemeFixture(), id: "Dracula-2" })).toBe(true);
    expect(isTheme({ ...validThemeFixture(), id: "my_theme" })).toBe(true);
    expect(isTheme({ ...validThemeFixture(), id: "abc123" })).toBe(true);
  });

  it("rejects missing name", () => {
    const broken = { ...validThemeFixture(), name: "" };
    expect(isTheme(broken)).toBe(false);
  });

  it("rejects non-boolean isDark", () => {
    expect(isTheme({ ...validThemeFixture(), isDark: "yes" })).toBe(false);
    expect(isTheme({ ...validThemeFixture(), isDark: 1 })).toBe(false);
  });

  it("rejects missing pair", () => {
    const broken = { ...validThemeFixture(), pair: "" };
    expect(isTheme(broken)).toBe(false);
  });

  it("rejects when vars is missing a required key", () => {
    const broken = validThemeFixture();
    const vars = { ...broken.vars } as Record<string, string>;
    delete vars["--bg"];
    expect(isTheme({ ...broken, vars })).toBe(false);
  });

  it("rejects when a var value is empty", () => {
    const broken = validThemeFixture();
    const vars = { ...broken.vars, "--bg": "" };
    expect(isTheme({ ...broken, vars })).toBe(false);
  });

  it("rejects when a var value is not a string", () => {
    const broken = validThemeFixture();
    const vars = { ...broken.vars, "--bg": 0xfff as unknown as string };
    expect(isTheme({ ...broken, vars })).toBe(false);
  });
});

describe("parseTheme", () => {
  it("parses valid JSON and returns the theme with custom=true", () => {
    const json = JSON.stringify(validThemeFixture({ id: "mine" }));
    const t = parseTheme(json);
    expect(t).not.toBeNull();
    expect(t!.id).toBe("mine");
    expect(t!.custom).toBe(true);
  });

  it("returns null on malformed JSON", () => {
    expect(parseTheme("{ not json")).toBeNull();
    expect(parseTheme("")).toBeNull();
  });

  it("returns null on JSON that doesn't match the Theme shape", () => {
    expect(parseTheme(JSON.stringify({ id: "x" }))).toBeNull();
    expect(parseTheme(JSON.stringify({ ...validThemeFixture(), pair: 1 }))).toBeNull();
  });

  it("strips unknown fields, keeping only the canonical shape", () => {
    const extra = { ...validThemeFixture(), evil: "<script>" };
    const t = parseTheme(JSON.stringify(extra));
    expect(t).not.toBeNull();
    expect((t as unknown as Record<string, unknown>).evil).toBeUndefined();
  });

  it("rejects themes whose id contains path-traversal characters", () => {
    // Today's bug: such a theme would pass JSON parsing but be silently
    // rejected by the Rust disk-write path. After I7 it's rejected up front.
    const evil = { ...validThemeFixture(), id: "../../evil" };
    expect(parseTheme(JSON.stringify(evil))).toBeNull();
  });
});

describe("buildThemeCatalog", () => {
  it("returns builtins when no customs provided", () => {
    const cat = buildThemeCatalog([]);
    expect(Object.keys(cat).sort()).toEqual(Object.keys(BUILTIN_THEMES).sort());
  });

  it("adds valid customs alongside builtins", () => {
    const custom = validThemeFixture({ id: "neon" });
    const cat = buildThemeCatalog([custom]);
    expect("neon" in cat).toBe(true);
    expect(cat["neon"].custom).toBe(true);
  });

  it("a custom with the same id overrides a builtin", () => {
    const override = validThemeFixture({ id: "dark", name: "My Dark" });
    const cat = buildThemeCatalog([override]);
    expect(cat["dark"].name).toBe("My Dark");
  });

  it("ignores invalid customs silently", () => {
    const cat = buildThemeCatalog([
      { id: "x" } as unknown as Theme,
      validThemeFixture({ id: "ok" }),
    ]);
    expect("x" in cat).toBe(false);
    expect("ok" in cat).toBe(true);
  });
});

describe("mergeCustomThemes — disk wins over store", () => {
  it("returns empty when both inputs are empty", () => {
    expect(mergeCustomThemes([], [])).toEqual([]);
  });

  it("includes themes from both lists when ids don't collide", () => {
    const result = mergeCustomThemes(
      [validThemeFixture({ id: "store-only" })],
      [validThemeFixture({ id: "disk-only" })]
    );
    const ids = result.map((t) => t.id).sort();
    expect(ids).toEqual(["disk-only", "store-only"]);
  });

  it("priority list overrides fallback on id collision", () => {
    const fromStore = validThemeFixture({ id: "shared", name: "Store version" });
    const fromDisk = validThemeFixture({ id: "shared", name: "Disk version" });
    const result = mergeCustomThemes([fromStore], [fromDisk]);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Disk version");
  });

  it("flags every merged theme as custom=true", () => {
    const result = mergeCustomThemes(
      [validThemeFixture({ id: "a" })],
      [validThemeFixture({ id: "b" })]
    );
    for (const t of result) {
      expect(t.custom).toBe(true);
    }
  });

  it("silently drops invalid entries from either list", () => {
    const result = mergeCustomThemes(
      [
        validThemeFixture({ id: "ok-store" }),
        { broken: true } as unknown as Theme,
      ],
      [
        { also: "broken" } as unknown as Theme,
        validThemeFixture({ id: "ok-disk" }),
      ]
    );
    const ids = result.map((t) => t.id).sort();
    expect(ids).toEqual(["ok-disk", "ok-store"]);
  });

  it("preserves the fallback ordering when ids don't collide", () => {
    // Map ordering follows insertion: fallback first, then priority's new ids.
    const result = mergeCustomThemes(
      [
        validThemeFixture({ id: "a" }),
        validThemeFixture({ id: "b" }),
      ],
      [validThemeFixture({ id: "c" })]
    );
    expect(result.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sanitizeCustomThemes", () => {
  it("returns empty array for non-array input", () => {
    expect(sanitizeCustomThemes(null)).toEqual([]);
    expect(sanitizeCustomThemes("not an array")).toEqual([]);
    expect(sanitizeCustomThemes(undefined)).toEqual([]);
  });

  it("filters out invalid entries", () => {
    const result = sanitizeCustomThemes([
      validThemeFixture({ id: "a" }),
      { broken: true },
      validThemeFixture({ id: "b" }),
    ]);
    expect(result.length).toBe(2);
    expect(result.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("flags every returned theme as custom", () => {
    const result = sanitizeCustomThemes([validThemeFixture({ id: "a" })]);
    expect(result[0].custom).toBe(true);
  });
});

describe("isThemeId", () => {
  const catalog = BUILTIN_THEMES;

  it("accepts every builtin id", () => {
    for (const id of Object.keys(catalog)) {
      expect(isThemeId(catalog, id)).toBe(true);
    }
  });

  it("rejects values not in the catalog", () => {
    expect(isThemeId(catalog, "unknown")).toBe(false);
    expect(isThemeId(catalog, null)).toBe(false);
    expect(isThemeId(catalog, 42)).toBe(false);
  });
});

describe("resolveInitialThemeId", () => {
  const catalog = BUILTIN_THEMES;

  it("uses the saved theme id when valid", () => {
    expect(resolveInitialThemeId(catalog, "dracula", null)).toBe("dracula");
  });

  it("migrates from legacy appearance='dark' to dark", () => {
    expect(resolveInitialThemeId(catalog, null, "dark")).toBe("dark");
  });

  it("migrates from legacy appearance='light' to light", () => {
    expect(resolveInitialThemeId(catalog, null, "light")).toBe("light");
  });

  it("defaults to light when nothing is saved", () => {
    expect(resolveInitialThemeId(catalog, null, null)).toBe("light");
  });

  it("prefers saved over legacy", () => {
    expect(resolveInitialThemeId(catalog, "dracula", "light")).toBe("dracula");
  });

  it("rejects invalid saved values and falls back", () => {
    expect(resolveInitialThemeId(catalog, "not-a-theme", "dark")).toBe("dark");
  });

  it("works with custom themes in the catalog", () => {
    const extended = buildThemeCatalog([validThemeFixture({ id: "neon" })]);
    expect(resolveInitialThemeId(extended, "neon", null)).toBe("neon");
  });
});

describe("resolveActiveThemeId — followSystem rule", () => {
  const catalog = BUILTIN_THEMES;

  it("returns base when followSystem=false", () => {
    expect(resolveActiveThemeId(catalog, "dracula", false, true)).toBe("dracula");
    expect(resolveActiveThemeId(catalog, "light", false, true)).toBe("light");
  });

  it("returns base when system matches the theme's isDark", () => {
    expect(resolveActiveThemeId(catalog, "light", true, false)).toBe("light");
    expect(resolveActiveThemeId(catalog, "dark", true, true)).toBe("dark");
  });

  it("returns the pair when system mismatches isDark", () => {
    expect(resolveActiveThemeId(catalog, "light", true, true)).toBe("dark");
    expect(resolveActiveThemeId(catalog, "dark", true, false)).toBe("light");
  });

  it("works with Solarized pair", () => {
    expect(resolveActiveThemeId(catalog, "solarized-light", true, true)).toBe(
      "solarized-dark"
    );
  });

  describe("custom theme fallbacks", () => {
    it("uses builtin 'dark' when a custom light theme has a missing pair", () => {
      const broken = validThemeFixture({
        id: "mine",
        isDark: false,
        pair: "ghost",
      });
      const extended = buildThemeCatalog([broken]);
      // system=dark, base=mine(light) → should switch to a dark theme
      expect(resolveActiveThemeId(extended, "mine", true, true)).toBe("dark");
    });

    it("uses builtin 'light' when a custom dark theme has a missing pair", () => {
      const broken = validThemeFixture({
        id: "mine",
        isDark: true,
        pair: "ghost",
      });
      const extended = buildThemeCatalog([broken]);
      expect(resolveActiveThemeId(extended, "mine", true, false)).toBe(
        "light"
      );
    });

    it("ignores a pair that has the wrong isDark and falls back to builtin", () => {
      // A custom dark theme that wrongly points to another dark theme.
      const custom = validThemeFixture({
        id: "mine",
        isDark: true,
        pair: "dracula", // also dark — wrong
      });
      const extended = buildThemeCatalog([custom]);
      // system=light, base=mine(dark): pair(dracula) is also dark → fallback to light
      expect(resolveActiveThemeId(extended, "mine", true, false)).toBe(
        "light"
      );
    });

    it("uses the configured pair when it has the correct isDark", () => {
      const custom = validThemeFixture({
        id: "mine",
        isDark: true,
        pair: "github", // light — correct
      });
      const extended = buildThemeCatalog([custom]);
      expect(resolveActiveThemeId(extended, "mine", true, false)).toBe(
        "github"
      );
    });
  });
});

describe("applyThemeToDOM", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("html");
  });

  it("writes every required CSS variable", () => {
    applyThemeToDOM(BUILTIN_THEMES, root, "dracula");
    for (const key of REQUIRED_VAR_KEYS) {
      expect(root.style.getPropertyValue(key)).toBe(
        BUILTIN_THEMES["dracula"].vars[key]
      );
    }
  });

  it("sets data-theme based on isDark", () => {
    applyThemeToDOM(BUILTIN_THEMES, root, "dracula");
    expect(root.dataset.theme).toBe("dark");
    applyThemeToDOM(BUILTIN_THEMES, root, "github");
    expect(root.dataset.theme).toBe("light");
  });

  it("stores the id in data-themeId", () => {
    applyThemeToDOM(BUILTIN_THEMES, root, "solarized-light");
    expect(root.dataset.themeId).toBe("solarized-light");
  });

  it("does nothing if the themeId is unknown", () => {
    applyThemeToDOM(BUILTIN_THEMES, root, "nope");
    expect(root.dataset.themeId).toBeUndefined();
  });
});
