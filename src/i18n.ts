import enCatalog from "./locales/en.json";
import frCatalog from "./locales/fr.json";

export type Locale = "fr" | "en";

export const LOCALES: readonly Locale[] = ["fr", "en"];
export const LOCALE_KEY = "locale";

const CATALOG: Record<Locale, Record<string, string>> = {
  fr: frCatalog as Record<string, string>,
  en: enCatalog as Record<string, string>,
};

let currentLocale: Locale = "fr";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

export function detectSystemLocale(navLanguage: string | undefined): Locale {
  if (!navLanguage) return "fr";
  return navLanguage.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function resolveInitialLocale(
  saved: unknown,
  navLanguage: string | undefined
): Locale {
  if (isLocale(saved)) return saved;
  return detectSystemLocale(navLanguage);
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function t(key: string, locale?: Locale): string {
  const dict = CATALOG[locale ?? currentLocale];
  return dict[key] ?? CATALOG.en[key] ?? key;
}

/** Returns the loaded catalog for a locale (read-only, useful for tests). */
export function getCatalog(locale: Locale): Readonly<Record<string, string>> {
  return CATALOG[locale];
}

/**
 * Walk the subtree and apply translations to elements with i18n attributes.
 *
 * - data-i18n="key"       → element.textContent
 * - data-i18n-title="key" → element.title
 * - data-i18n-placeholder="key" → element.placeholder
 *
 * Translations are written as plain text only; HTML injection from catalogs
 * is intentionally not supported to avoid XSS if catalogs ever become
 * user-supplied.
 */
export function applyTranslations(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>(
    "[data-i18n-placeholder]"
  )) {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.placeholder = t(key);
  }
}
