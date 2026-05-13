import darkJson from "./themes/dark.json";
import draculaJson from "./themes/dracula.json";
import githubJson from "./themes/github.json";
import lightJson from "./themes/light.json";
import nordJson from "./themes/nord.json";
import sepiaJson from "./themes/sepia.json";
import solarizedDarkJson from "./themes/solarized-dark.json";
import solarizedLightJson from "./themes/solarized-light.json";

export type ThemeId = string;

export const REQUIRED_VAR_KEYS = [
  "--bg",
  "--sidebar-bg",
  "--sidebar-hover",
  "--sidebar-active",
  "--border",
  "--text",
  "--text-muted",
  "--accent",
  "--accent-light",
  "--code-bg",
  "--table-border",
  "--table-stripe",
  "--search-hit",
  "--search-hit-active",
] as const;

export type ThemeVarKey = (typeof REQUIRED_VAR_KEYS)[number];
export type ThemeVars = Record<ThemeVarKey, string>;

export interface Theme {
  id: ThemeId;
  name: string;
  isDark: boolean;
  pair: ThemeId;
  vars: ThemeVars;
  custom?: boolean;
}

export const THEME_KEY = "themeId";
export const FOLLOW_SYSTEM_KEY = "followSystem";
export const CUSTOM_THEMES_KEY = "customThemes";

const BUILTIN_LIST: Theme[] = [
  lightJson as Theme,
  darkJson as Theme,
  githubJson as Theme,
  draculaJson as Theme,
  solarizedLightJson as Theme,
  solarizedDarkJson as Theme,
  nordJson as Theme,
  sepiaJson as Theme,
];

export const BUILTIN_THEMES: Record<ThemeId, Theme> = Object.fromEntries(
  BUILTIN_LIST.map((t) => [t.id, t])
);

export const BUILTIN_THEME_ORDER: readonly ThemeId[] = BUILTIN_LIST.map(
  (t) => t.id
);

/**
 * Allowed characters for theme ids. Mirrors the constraint enforced by the
 * Rust commands save_disk_theme / delete_disk_theme so a theme that passes
 * JS validation can always be persisted to disk (no silent failures, no
 * path-traversal sequences smuggled in).
 */
export const VALID_THEME_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Returns true when `id` is a safe identifier (matches VALID_THEME_ID_RE). */
export function isValidThemeId(id: unknown): id is string {
  return typeof id === "string" && VALID_THEME_ID_RE.test(id);
}

/**
 * Returns true when `value` is a CSS color the browser actually recognises.
 *
 * Why: theme `vars` are pushed into `root.style.setProperty(...)`, and several
 * rules in `index.html` consume them via the `background` shorthand — which
 * accepts `url(...)`. A malicious imported theme could set `--bg` to
 * `url(https://attacker/leak)` and trigger an outbound HTTP request on theme
 * application. Validating each var as a real color closes that vector.
 *
 * How to apply: gate every required var in `isTheme`. Uses the browser as the
 * parser (same trick as `toHexForPicker`) so we accept exactly what CSS does.
 */
function isCssColor(value: string): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("div");
  probe.style.color = "";
  probe.style.color = value;
  return probe.style.color !== "";
}

/**
 * Validate that `value` is a structurally complete Theme.
 * Used both for builtins (sanity check) and for user-imported JSON.
 *
 * Theme ids must match VALID_THEME_ID_RE; otherwise the theme is rejected
 * outright, both because the Rust disk-storage commands would refuse to
 * write the file (silent failure today) and because an id like
 * `"../../evil"` would be a path-traversal vector if any code path ever
 * concatenated it into a filesystem path.
 */
export function isTheme(value: unknown): value is Theme {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!isValidThemeId(obj.id)) return false;
  if (typeof obj.name !== "string" || obj.name.length === 0) return false;
  if (typeof obj.isDark !== "boolean") return false;
  if (typeof obj.pair !== "string" || obj.pair.length === 0) return false;
  if (!obj.vars || typeof obj.vars !== "object") return false;
  const vars = obj.vars as Record<string, unknown>;
  for (const key of REQUIRED_VAR_KEYS) {
    const v = vars[key];
    if (typeof v !== "string" || v.length === 0) return false;
    if (!isCssColor(v)) return false;
  }
  return true;
}

/** Parse a JSON string and return a Theme, or null if invalid. */
export function parseTheme(jsonText: string): Theme | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isTheme(parsed)) return null;
  // Strip any extra fields; keep only the canonical shape (+ custom flag).
  const t = parsed as Theme;
  return {
    id: t.id,
    name: t.name,
    isDark: t.isDark,
    pair: t.pair,
    vars: t.vars,
    custom: true,
  };
}

/** Build the merged catalog of builtins + customs, customs win on id collision. */
export function buildThemeCatalog(
  customs: readonly Theme[]
): Record<ThemeId, Theme> {
  const map: Record<ThemeId, Theme> = { ...BUILTIN_THEMES };
  for (const c of customs) {
    if (isTheme(c)) map[c.id] = { ...c, custom: true };
  }
  return map;
}

export function isThemeId(catalog: Record<ThemeId, Theme>, value: unknown): value is ThemeId {
  return typeof value === "string" && value in catalog;
}

export function resolveInitialThemeId(
  catalog: Record<ThemeId, Theme>,
  saved: unknown,
  legacyAppearance: unknown
): ThemeId {
  if (isThemeId(catalog, saved)) return saved;
  if (legacyAppearance === "dark" && "dark" in catalog) return "dark";
  if (legacyAppearance === "light" && "light" in catalog) return "light";
  return "light";
}

export function resolveActiveThemeId(
  catalog: Record<ThemeId, Theme>,
  baseId: ThemeId,
  followSystem: boolean,
  systemPrefersDark: boolean
): ThemeId {
  const base = catalog[baseId];
  if (!followSystem || !base) return baseId;
  if (systemPrefersDark === base.isDark) return baseId;

  // Try the configured pair first; only accept it if it has the desired isDark.
  const pair = catalog[base.pair];
  if (pair && pair.isDark === systemPrefersDark) return pair.id;

  // Fall back to the builtin light/dark theme so the toggle always works,
  // even when a custom theme has a missing or wrongly-configured pair.
  const fallbackId = systemPrefersDark ? "dark" : "light";
  if (catalog[fallbackId]?.isDark === systemPrefersDark) return fallbackId;

  // Last resort: any catalog theme that matches the desired isDark.
  for (const t of Object.values(catalog)) {
    if (t.isDark === systemPrefersDark) return t.id;
  }
  return baseId;
}

export function applyThemeToDOM(
  catalog: Record<ThemeId, Theme>,
  root: HTMLElement,
  themeId: ThemeId
): void {
  const theme = catalog[themeId];
  if (!theme) return;
  for (const key of REQUIRED_VAR_KEYS) {
    root.style.setProperty(key, theme.vars[key]);
  }
  root.dataset.theme = theme.isDark ? "dark" : "light";
  root.dataset.themeId = themeId;
}

/** Validate an unknown list (e.g. from store) and return only valid themes. */
export function sanitizeCustomThemes(value: unknown): Theme[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isTheme).map((t) => ({ ...t, custom: true }));
}

/**
 * Merge two lists of custom themes by id. Themes from `priority` win over
 * those from `fallback` when ids collide.
 */
export function mergeCustomThemes(
  fallback: readonly Theme[],
  priority: readonly Theme[]
): Theme[] {
  const map = new Map<ThemeId, Theme>();
  for (const t of fallback) {
    if (isTheme(t)) map.set(t.id, { ...t, custom: true });
  }
  for (const t of priority) {
    if (isTheme(t)) map.set(t.id, { ...t, custom: true });
  }
  return Array.from(map.values());
}
