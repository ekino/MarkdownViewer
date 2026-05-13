import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveDark,
  resolveInitialAppearance,
  resolveInitialFontSize,
  resolveInitialOutlinePref,
  resolveInitialFontWeight,
  resolveInitialFontFamily,
  resolveInitialCustomFontSize,
  isAppearance,
  isFontSize,
  isOutlinePref,
  isFontWeight,
  isValidFontFamily,
  isValidCustomFontSize,
  setSegmentActive,
  applyAppearanceToDOM,
  applyFontSizeToDOM,
  applyOutlinePrefToDOM,
  applyBodyFontToDOM,
  applyCodeFontToDOM,
  applyFontWeightToDOM,
  applyCustomFontSizeToDOM,
  effectiveFontSizePx,
  PRESET_FONT_SIZE_PX,
  MIN_CUSTOM_FONT_SIZE,
  MAX_CUSTOM_FONT_SIZE,
} from "./preferences";

describe("resolveDark", () => {
  it("returns true when appearance is dark, regardless of system", () => {
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("dark", true)).toBe(true);
  });

  it("returns false when appearance is light, regardless of system", () => {
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("light", false)).toBe(false);
  });

  it("follows the system preference when appearance is system", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });
});

describe("resolveInitialAppearance", () => {
  it("uses a valid saved appearance when present", () => {
    expect(resolveInitialAppearance("dark", null)).toBe("dark");
    expect(resolveInitialAppearance("light", null)).toBe("light");
    expect(resolveInitialAppearance("system", null)).toBe("system");
  });

  it("falls back to legacy theme key when appearance is absent", () => {
    expect(resolveInitialAppearance(null, "dark")).toBe("dark");
    expect(resolveInitialAppearance(null, "light")).toBe("light");
  });

  it("ignores legacy theme values that aren't light or dark", () => {
    expect(resolveInitialAppearance(null, "system")).toBe("system");
    expect(resolveInitialAppearance(null, "rainbow")).toBe("system");
  });

  it("defaults to system when nothing is saved", () => {
    expect(resolveInitialAppearance(null, null)).toBe("system");
    expect(resolveInitialAppearance(undefined, undefined)).toBe("system");
  });

  it("rejects garbage saved values and defaults to system", () => {
    expect(resolveInitialAppearance(42, null)).toBe("system");
    expect(resolveInitialAppearance({ theme: "dark" }, null)).toBe("system");
    expect(resolveInitialAppearance("neon", null)).toBe("system");
  });

  it("prefers saved appearance over legacy theme", () => {
    expect(resolveInitialAppearance("system", "dark")).toBe("system");
    expect(resolveInitialAppearance("light", "dark")).toBe("light");
  });
});

describe("resolveInitialFontSize", () => {
  it("accepts valid sizes", () => {
    expect(resolveInitialFontSize("small")).toBe("small");
    expect(resolveInitialFontSize("medium")).toBe("medium");
    expect(resolveInitialFontSize("large")).toBe("large");
  });

  it("defaults to medium for unknown or missing values", () => {
    expect(resolveInitialFontSize(null)).toBe("medium");
    expect(resolveInitialFontSize(undefined)).toBe("medium");
    expect(resolveInitialFontSize("huge")).toBe("medium");
    expect(resolveInitialFontSize(15)).toBe("medium");
  });
});

describe("resolveInitialOutlinePref", () => {
  it("accepts valid prefs", () => {
    expect(resolveInitialOutlinePref("auto")).toBe("auto");
    expect(resolveInitialOutlinePref("always")).toBe("always");
    expect(resolveInitialOutlinePref("hidden")).toBe("hidden");
  });

  it("defaults to auto for unknown or missing values", () => {
    expect(resolveInitialOutlinePref(null)).toBe("auto");
    expect(resolveInitialOutlinePref("off")).toBe("auto");
  });
});

describe("type guards", () => {
  it("isAppearance only accepts the three valid strings", () => {
    expect(isAppearance("dark")).toBe(true);
    expect(isAppearance("light")).toBe(true);
    expect(isAppearance("system")).toBe(true);
    expect(isAppearance("Dark")).toBe(false);
    expect(isAppearance(null)).toBe(false);
    expect(isAppearance(undefined)).toBe(false);
  });

  it("isFontSize only accepts the three valid sizes", () => {
    expect(isFontSize("small")).toBe(true);
    expect(isFontSize("medium")).toBe(true);
    expect(isFontSize("large")).toBe(true);
    expect(isFontSize("xl")).toBe(false);
  });

  it("isOutlinePref only accepts the three valid prefs", () => {
    expect(isOutlinePref("auto")).toBe(true);
    expect(isOutlinePref("always")).toBe(true);
    expect(isOutlinePref("hidden")).toBe(true);
    expect(isOutlinePref("none")).toBe(false);
  });
});

describe("setSegmentActive", () => {
  let group: HTMLDivElement;

  beforeEach(() => {
    group = document.createElement("div");
    for (const v of ["system", "light", "dark"]) {
      const b = document.createElement("button");
      b.dataset.value = v;
      group.appendChild(b);
    }
  });

  it("marks exactly the matching button active", () => {
    setSegmentActive(group, "dark");
    const actives = group.querySelectorAll("button.active");
    expect(actives.length).toBe(1);
    expect((actives[0] as HTMLButtonElement).dataset.value).toBe("dark");
  });

  it("clears previously active buttons when switching", () => {
    setSegmentActive(group, "dark");
    setSegmentActive(group, "light");
    const actives = group.querySelectorAll("button.active");
    expect(actives.length).toBe(1);
    expect((actives[0] as HTMLButtonElement).dataset.value).toBe("light");
  });

  it("leaves all buttons inactive when value matches none", () => {
    setSegmentActive(group, "dark");
    setSegmentActive(group, "nope");
    expect(group.querySelectorAll("button.active").length).toBe(0);
  });
});

describe("DOM appliers", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("html");
  });

  it("applyAppearanceToDOM writes data-theme", () => {
    applyAppearanceToDOM(root, true);
    expect(root.dataset.theme).toBe("dark");
    applyAppearanceToDOM(root, false);
    expect(root.dataset.theme).toBe("light");
  });

  it("applyFontSizeToDOM writes data-fontsize", () => {
    applyFontSizeToDOM(root, "large");
    expect(root.dataset.fontsize).toBe("large");
  });

  it("applyOutlinePrefToDOM writes data-outline", () => {
    applyOutlinePrefToDOM(root, "hidden");
    expect(root.dataset.outline).toBe("hidden");
  });
});

describe("advanced typography type guards", () => {
  it("isFontWeight accepts the five canonical weights", () => {
    expect(isFontWeight("300")).toBe(true);
    expect(isFontWeight("400")).toBe(true);
    expect(isFontWeight("500")).toBe(true);
    expect(isFontWeight("600")).toBe(true);
    expect(isFontWeight("700")).toBe(true);
  });

  it("isFontWeight rejects other values", () => {
    expect(isFontWeight("100")).toBe(false);
    expect(isFontWeight("800")).toBe(false);
    expect(isFontWeight(400)).toBe(false);
    expect(isFontWeight(null)).toBe(false);
    expect(isFontWeight("bold")).toBe(false);
  });

  it("isValidFontFamily accepts non-empty strings", () => {
    expect(isValidFontFamily("Helvetica")).toBe(true);
    expect(isValidFontFamily("Comic Sans MS")).toBe(true);
  });

  it("isValidFontFamily rejects empty, whitespace, or non-strings", () => {
    expect(isValidFontFamily("")).toBe(false);
    expect(isValidFontFamily("   ")).toBe(false);
    expect(isValidFontFamily(null)).toBe(false);
    expect(isValidFontFamily(42)).toBe(false);
  });

  it("isValidCustomFontSize accepts values inside the range", () => {
    expect(isValidCustomFontSize(MIN_CUSTOM_FONT_SIZE)).toBe(true);
    expect(isValidCustomFontSize(15)).toBe(true);
    expect(isValidCustomFontSize(MAX_CUSTOM_FONT_SIZE)).toBe(true);
  });

  it("isValidCustomFontSize rejects out-of-range or non-numbers", () => {
    expect(isValidCustomFontSize(MIN_CUSTOM_FONT_SIZE - 1)).toBe(false);
    expect(isValidCustomFontSize(MAX_CUSTOM_FONT_SIZE + 1)).toBe(false);
    expect(isValidCustomFontSize(NaN)).toBe(false);
    expect(isValidCustomFontSize(Infinity)).toBe(false);
    expect(isValidCustomFontSize("15")).toBe(false);
    expect(isValidCustomFontSize(null)).toBe(false);
  });
});

describe("advanced typography resolvers", () => {
  it("resolveInitialFontWeight returns the value when valid, null otherwise", () => {
    expect(resolveInitialFontWeight("500")).toBe("500");
    expect(resolveInitialFontWeight("400")).toBe("400");
    expect(resolveInitialFontWeight(null)).toBeNull();
    expect(resolveInitialFontWeight("200")).toBeNull();
    expect(resolveInitialFontWeight(500)).toBeNull();
  });

  it("resolveInitialFontFamily returns the value when valid, null otherwise", () => {
    expect(resolveInitialFontFamily("Inter")).toBe("Inter");
    expect(resolveInitialFontFamily("")).toBeNull();
    expect(resolveInitialFontFamily(null)).toBeNull();
    expect(resolveInitialFontFamily(undefined)).toBeNull();
  });

  it("resolveInitialCustomFontSize returns the value when valid, null otherwise", () => {
    expect(resolveInitialCustomFontSize(16)).toBe(16);
    expect(resolveInitialCustomFontSize(10)).toBe(10);
    expect(resolveInitialCustomFontSize(32)).toBe(32);
    expect(resolveInitialCustomFontSize(9)).toBeNull();
    expect(resolveInitialCustomFontSize(33)).toBeNull();
    expect(resolveInitialCustomFontSize("16")).toBeNull();
    expect(resolveInitialCustomFontSize(null)).toBeNull();
  });
});

describe("effectiveFontSizePx — preset vs custom override", () => {
  it("returns the preset size when no custom override is set", () => {
    expect(effectiveFontSizePx("small", null)).toBe(PRESET_FONT_SIZE_PX.small);
    expect(effectiveFontSizePx("medium", null)).toBe(
      PRESET_FONT_SIZE_PX.medium
    );
    expect(effectiveFontSizePx("large", null)).toBe(PRESET_FONT_SIZE_PX.large);
  });

  it("custom size overrides the preset", () => {
    expect(effectiveFontSizePx("small", 20)).toBe(20);
    expect(effectiveFontSizePx("medium", 12)).toBe(12);
    expect(effectiveFontSizePx("large", 24)).toBe(24);
  });

  it("preset values are sorted small < medium < large", () => {
    expect(PRESET_FONT_SIZE_PX.small).toBeLessThan(PRESET_FONT_SIZE_PX.medium);
    expect(PRESET_FONT_SIZE_PX.medium).toBeLessThan(PRESET_FONT_SIZE_PX.large);
  });
});

describe("advanced DOM appliers — CSS variables", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("html");
  });

  it("applyBodyFontToDOM sets and clears --md-body-font (quoted)", () => {
    applyBodyFontToDOM(root, "Inter");
    expect(root.style.getPropertyValue("--md-body-font")).toBe('"Inter"');
    applyBodyFontToDOM(root, null);
    expect(root.style.getPropertyValue("--md-body-font")).toBe("");
  });

  it("applyBodyFontToDOM quotes family names containing spaces", () => {
    applyBodyFontToDOM(root, "Comic Sans MS");
    expect(root.style.getPropertyValue("--md-body-font")).toBe(
      '"Comic Sans MS"'
    );
  });

  it("applyBodyFontToDOM escapes embedded double quotes", () => {
    applyBodyFontToDOM(root, 'Weird"Font');
    expect(root.style.getPropertyValue("--md-body-font")).toBe(
      '"Weird\\"Font"'
    );
  });

  it("applyCodeFontToDOM sets and clears --md-code-font", () => {
    applyCodeFontToDOM(root, "JetBrains Mono");
    expect(root.style.getPropertyValue("--md-code-font")).toBe(
      '"JetBrains Mono"'
    );
    applyCodeFontToDOM(root, null);
    expect(root.style.getPropertyValue("--md-code-font")).toBe("");
  });

  it("applyFontWeightToDOM sets and clears --md-body-weight", () => {
    applyFontWeightToDOM(root, "600");
    expect(root.style.getPropertyValue("--md-body-weight")).toBe("600");
    applyFontWeightToDOM(root, null);
    expect(root.style.getPropertyValue("--md-body-weight")).toBe("");
  });

  it("applyCustomFontSizeToDOM sets and clears --md-body-size in px", () => {
    applyCustomFontSizeToDOM(root, 18);
    expect(root.style.getPropertyValue("--md-body-size")).toBe("18px");
    applyCustomFontSizeToDOM(root, null);
    expect(root.style.getPropertyValue("--md-body-size")).toBe("");
  });
});
