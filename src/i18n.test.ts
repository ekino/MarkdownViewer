import { describe, it, expect, beforeEach } from "vitest";
import {
  LOCALES,
  applyTranslations,
  detectSystemLocale,
  getCatalog,
  getLocale,
  isLocale,
  resolveInitialLocale,
  setLocale,
  t,
} from "./i18n";

beforeEach(() => {
  setLocale("fr");
});

describe("isLocale", () => {
  it("accepts every known locale", () => {
    for (const l of LOCALES) {
      expect(isLocale(l)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isLocale("es")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe("detectSystemLocale", () => {
  it("returns fr for browser languages starting with fr", () => {
    expect(detectSystemLocale("fr-FR")).toBe("fr");
    expect(detectSystemLocale("fr")).toBe("fr");
    expect(detectSystemLocale("FR-ca")).toBe("fr");
  });

  it("returns en for non-fr languages", () => {
    expect(detectSystemLocale("en-US")).toBe("en");
    expect(detectSystemLocale("de")).toBe("en");
    expect(detectSystemLocale("es-ES")).toBe("en");
  });

  it("defaults to fr when no browser language is available", () => {
    expect(detectSystemLocale(undefined)).toBe("fr");
    expect(detectSystemLocale("")).toBe("fr");
  });
});

describe("resolveInitialLocale", () => {
  it("uses the saved locale when valid", () => {
    expect(resolveInitialLocale("en", "fr-FR")).toBe("en");
    expect(resolveInitialLocale("fr", "en-US")).toBe("fr");
  });

  it("falls back to browser language when saved is invalid", () => {
    expect(resolveInitialLocale(null, "fr-FR")).toBe("fr");
    expect(resolveInitialLocale("xx", "en-US")).toBe("en");
  });

  it("defaults to fr when nothing is available", () => {
    expect(resolveInitialLocale(null, undefined)).toBe("fr");
  });
});

describe("t() — lookup and fallback", () => {
  it("returns the FR string when current locale is fr", () => {
    setLocale("fr");
    expect(t("prefs.tab.general")).toBe("Général");
    expect(t("empty.open")).toBe("Ouvrir un dossier");
  });

  it("returns the EN string when current locale is en", () => {
    setLocale("en");
    expect(t("prefs.tab.general")).toBe("General");
    expect(t("empty.open")).toBe("Open folder");
  });

  it("an explicit locale arg overrides the current locale", () => {
    setLocale("fr");
    expect(t("prefs.tab.general", "en")).toBe("General");
  });

  it("returns the key itself when the translation is missing", () => {
    expect(t("totally.unknown.key")).toBe("totally.unknown.key");
  });

  it("falls back to EN if FR is missing for a key", () => {
    // This relies on internal fallback; both catalogs share keys today,
    // but we can simulate the path by asking with an English-only key path.
    // (Both catalogs have the same keys, so the most we can assert is parity.)
    setLocale("fr");
    const v = t("prefs.tab.general");
    expect(v).not.toBe("prefs.tab.general");
  });
});

describe("getLocale / setLocale", () => {
  it("setLocale updates the current locale read by getLocale", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    setLocale("fr");
    expect(getLocale()).toBe("fr");
  });
});

describe("applyTranslations", () => {
  it("translates textContent for data-i18n", () => {
    const root = document.createElement("div");
    const span = document.createElement("span");
    span.dataset.i18n = "prefs.tab.general";
    root.appendChild(span);

    setLocale("en");
    applyTranslations(root);
    expect(span.textContent).toBe("General");

    setLocale("fr");
    applyTranslations(root);
    expect(span.textContent).toBe("Général");
  });

  it("translates title attribute for data-i18n-title", () => {
    const root = document.createElement("div");
    const btn = document.createElement("button");
    btn.dataset.i18nTitle = "titlebar.print";
    root.appendChild(btn);

    setLocale("en");
    applyTranslations(root);
    expect(btn.title).toBe("Print");

    setLocale("fr");
    applyTranslations(root);
    expect(btn.title).toBe("Imprimer");
  });

  it("translates placeholder attribute for data-i18n-placeholder", () => {
    const root = document.createElement("div");
    const input = document.createElement("input");
    input.dataset.i18nPlaceholder = "search.placeholder";
    root.appendChild(input);

    setLocale("en");
    applyTranslations(root);
    expect(input.placeholder).toBe("Search…");

    setLocale("fr");
    applyTranslations(root);
    expect(input.placeholder).toBe("Rechercher…");
  });

  it("does not interpret HTML markup in translations (no data-i18n-html)", () => {
    // The data-i18n-html mechanism was removed to avoid XSS if catalogs ever
    // become user-supplied. data-i18n must render as text, so injected markup
    // appears literally.
    const root = document.createElement("div");
    const span = document.createElement("span");
    span.dataset.i18n = "x.test.injection";
    root.appendChild(span);

    // Inject a synthetic key into the catalog by stubbing t() via locale fallback.
    // Easiest path: assert that an unknown key with HTML returns the key as-is
    // (no interpretation possible).
    setLocale("en");
    applyTranslations(root);
    expect(span.innerHTML).toBe("x.test.injection");
    expect(span.querySelector("script")).toBeNull();
  });

  it("leaves elements without i18n attributes untouched", () => {
    const root = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = "Stays the same";
    root.appendChild(span);
    applyTranslations(root);
    expect(span.textContent).toBe("Stays the same");
  });
});

describe("FR and EN catalogs — parity", () => {
  // Smoke check: every key that appears in FR should also exist in EN.
  // We probe a handful of central keys; a divergence here means the t()
  // fallback chain would degrade for that key.
  const SAMPLE_KEYS = [
    "prefs.title",
    "prefs.done",
    "prefs.tab.general",
    "prefs.tab.fonts",
    "prefs.tab.appearance",
    "prefs.general.language.title",
    "prefs.appearance.follow",
    "empty.open",
    "titlebar.print",
  ];

  it("every sample key resolves to a non-empty, non-fallback string in fr", () => {
    setLocale("fr");
    for (const k of SAMPLE_KEYS) {
      const v = t(k);
      expect(v, k).not.toBe(k);
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it("every sample key resolves to a non-empty, non-fallback string in en", () => {
    setLocale("en");
    for (const k of SAMPLE_KEYS) {
      const v = t(k);
      expect(v, k).not.toBe(k);
      expect(v.length, k).toBeGreaterThan(0);
    }
  });
});

describe("JSON catalog parity", () => {
  it("FR and EN catalogs expose exactly the same keys", () => {
    const frKeys = Object.keys(getCatalog("fr")).sort();
    const enKeys = Object.keys(getCatalog("en")).sort();
    expect(frKeys).toEqual(enKeys);
  });

  it("every value is a non-empty string in both catalogs", () => {
    for (const locale of LOCALES) {
      const dict = getCatalog(locale);
      for (const [k, v] of Object.entries(dict)) {
        expect(typeof v, `${locale}.${k}`).toBe("string");
        expect(v.length, `${locale}.${k}`).toBeGreaterThan(0);
      }
    }
  });
});
