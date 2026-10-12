export type Appearance = "system" | "light" | "dark";
export type FontSize = "small" | "medium" | "large";
export type OutlinePref = "auto" | "always" | "hidden";
/** What happens when a document is opened from Finder while a window is open. */
export type FinderOpenPref = "new-window" | "reuse";

export const APPEARANCE_VALUES: readonly Appearance[] = [
  "system",
  "light",
  "dark",
];
export const FONTSIZE_VALUES: readonly FontSize[] = [
  "small",
  "medium",
  "large",
];
export const OUTLINE_VALUES: readonly OutlinePref[] = [
  "auto",
  "always",
  "hidden",
];
export const FINDER_OPEN_VALUES: readonly FinderOpenPref[] = [
  "new-window",
  "reuse",
];

export const APPEARANCE_KEY = "appearance";
export const FONTSIZE_KEY = "fontSize";
export const OUTLINE_PREF_KEY = "outlinePref";
export const FINDER_OPEN_KEY = "finderOpenPref";
export const LAUNCH_KEY = "launchView";
export const LEGACY_THEME_KEY = "theme";

export const BODY_FONT_KEY = "bodyFontFamily";
export const CODE_FONT_KEY = "codeFontFamily";
export const FONT_WEIGHT_KEY = "fontWeight";
export const CUSTOM_FONT_SIZE_KEY = "customFontSizePx";

export const FONT_WEIGHT_VALUES = [
  "300",
  "400",
  "500",
  "600",
  "700",
] as const;
export type FontWeight = (typeof FONT_WEIGHT_VALUES)[number];

export const MIN_CUSTOM_FONT_SIZE = 10;
export const MAX_CUSTOM_FONT_SIZE = 32;

export interface AdvancedTypography {
  bodyFontFamily: string | null;
  codeFontFamily: string | null;
  fontWeight: FontWeight | null;
  customFontSizePx: number | null;
}

export function emptyAdvancedTypography(): AdvancedTypography {
  return {
    bodyFontFamily: null,
    codeFontFamily: null,
    fontWeight: null,
    customFontSizePx: null,
  };
}

export function isAppearance(value: unknown): value is Appearance {
  return (
    typeof value === "string" &&
    (APPEARANCE_VALUES as readonly string[]).includes(value)
  );
}

export function isFontSize(value: unknown): value is FontSize {
  return (
    typeof value === "string" &&
    (FONTSIZE_VALUES as readonly string[]).includes(value)
  );
}

export function isOutlinePref(value: unknown): value is OutlinePref {
  return (
    typeof value === "string" &&
    (OUTLINE_VALUES as readonly string[]).includes(value)
  );
}

export function isFontWeight(value: unknown): value is FontWeight {
  return (
    typeof value === "string" &&
    (FONT_WEIGHT_VALUES as readonly string[]).includes(value)
  );
}

export function isValidFontFamily(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isValidCustomFontSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_CUSTOM_FONT_SIZE &&
    value <= MAX_CUSTOM_FONT_SIZE
  );
}

export function resolveInitialFontWeight(value: unknown): FontWeight | null {
  return isFontWeight(value) ? value : null;
}

export function resolveInitialFontFamily(value: unknown): string | null {
  return isValidFontFamily(value) ? value : null;
}

export function resolveInitialCustomFontSize(
  value: unknown
): number | null {
  return isValidCustomFontSize(value) ? value : null;
}

export const PRESET_FONT_SIZE_PX: Record<FontSize, number> = {
  small: 13,
  medium: 15,
  large: 17,
};

export function effectiveFontSizePx(
  preset: FontSize,
  custom: number | null
): number {
  return custom ?? PRESET_FONT_SIZE_PX[preset];
}

export function resolveDark(
  appearance: Appearance,
  systemPrefersDark: boolean
): boolean {
  if (appearance === "dark") return true;
  if (appearance === "light") return false;
  return systemPrefersDark;
}

export function resolveInitialAppearance(
  savedAppearance: unknown,
  legacyTheme: unknown
): Appearance {
  if (isAppearance(savedAppearance)) return savedAppearance;
  if (legacyTheme === "dark" || legacyTheme === "light") return legacyTheme;
  return "system";
}

export function resolveInitialFontSize(value: unknown): FontSize {
  return isFontSize(value) ? value : "medium";
}

export function isFinderOpenPref(value: unknown): value is FinderOpenPref {
  return (
    typeof value === "string" &&
    (FINDER_OPEN_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Defaults to opening a new window, matching how macOS document viewers behave:
 * opening a file from Finder should not discard what the current window shows.
 */
export function resolveInitialFinderOpenPref(value: unknown): FinderOpenPref {
  return isFinderOpenPref(value) ? value : "new-window";
}

export function resolveInitialOutlinePref(value: unknown): OutlinePref {
  return isOutlinePref(value) ? value : "auto";
}

export function setSegmentActive(group: HTMLElement, value: string): void {
  for (const btn of group.querySelectorAll<HTMLButtonElement>("button")) {
    const on = btn.dataset.value === value;
    btn.classList.toggle("active", on);
    if (btn.getAttribute("role") === "radio") {
      btn.setAttribute("aria-checked", String(on));
      btn.tabIndex = on ? 0 : -1;
    }
  }
}

export function applyFontSizeToDOM(
  root: HTMLElement,
  size: FontSize
): void {
  root.dataset.fontsize = size;
}

export function applyOutlinePrefToDOM(
  root: HTMLElement,
  pref: OutlinePref
): void {
  root.dataset.outline = pref;
}

export function applyAppearanceToDOM(
  root: HTMLElement,
  dark: boolean
): void {
  root.dataset.theme = dark ? "dark" : "light";
}

function cssFamily(name: string): string {
  // Quote unconditionally — handles spaces, dashes safely.
  return `"${name.replace(/"/g, '\\"')}"`;
}

export function applyBodyFontToDOM(
  root: HTMLElement,
  family: string | null
): void {
  if (family) {
    root.style.setProperty("--md-body-font", cssFamily(family));
  } else {
    root.style.removeProperty("--md-body-font");
  }
}

export function applyCodeFontToDOM(
  root: HTMLElement,
  family: string | null
): void {
  if (family) {
    root.style.setProperty("--md-code-font", cssFamily(family));
  } else {
    root.style.removeProperty("--md-code-font");
  }
}

export function applyFontWeightToDOM(
  root: HTMLElement,
  weight: FontWeight | null
): void {
  if (weight) {
    root.style.setProperty("--md-body-weight", weight);
  } else {
    root.style.removeProperty("--md-body-weight");
  }
}

export function applyCustomFontSizeToDOM(
  root: HTMLElement,
  sizePx: number | null
): void {
  if (sizePx !== null) {
    root.style.setProperty("--md-body-size", `${sizePx}px`);
  } else {
    root.style.removeProperty("--md-body-size");
  }
}

/** What a window shows when the app starts with nothing to open. */
export type LaunchPref = "home" | "last-folder";
export const LAUNCH_VALUES: readonly LaunchPref[] = ["home", "last-folder"];

export function isLaunchPref(value: unknown): value is LaunchPref {
  return typeof value === "string" && (LAUNCH_VALUES as readonly string[]).includes(value);
}

/** Defaults to the home screen ("Reprendre") rather than reopening the last folder. */
export function resolveInitialLaunchPref(value: unknown): LaunchPref {
  return isLaunchPref(value) ? value : "home";
}

/**
 * The settings to write: the keys whose value differs from `before`, plus
 * every key of `forced` (what the reader just chose, written even when this
 * window already had it, since another window may have changed the store).
 */
export function changedSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  forced: Record<string, unknown> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) out[key] = value;
  }
  return { ...out, ...forced };
}

/**
 * The settings one save should write: those that changed since `before`,
 * those the reader just chose (`forced`), and those whose last write failed
 * (`unsaved`), taken from the current values.
 */
export function settingsToWrite(
  current: Record<string, unknown>,
  before: Record<string, unknown>,
  forced: Record<string, unknown>,
  unsaved: ReadonlySet<string>
): Record<string, unknown> {
  const retry: Record<string, unknown> = {};
  for (const key of unsaved) {
    if (key in current) retry[key] = current[key];
  }
  return { ...retry, ...changedSettings(before, current, forced) };
}

/** After a write: its keys are saved, or still to be written. */
export function settleWrite(
  unsaved: Set<string>,
  written: Record<string, unknown>,
  ok: boolean
): void {
  for (const key of Object.keys(written)) {
    if (ok) unsaved.delete(key);
    else unsaved.add(key);
  }
}
