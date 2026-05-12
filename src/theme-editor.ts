import { REQUIRED_VAR_KEYS, type ThemeVarKey } from "./themes";

/**
 * Human-friendly metadata for each CSS variable. Used by the editor to render
 * a label and a short description next to the color picker.
 */
export interface VarMeta {
  key: ThemeVarKey;
  labelKey: string;
}

export const VAR_META: readonly VarMeta[] = [
  { key: "--bg", labelKey: "editor.var.bg" },
  { key: "--text", labelKey: "editor.var.text" },
  { key: "--text-muted", labelKey: "editor.var.text-muted" },
  { key: "--accent", labelKey: "editor.var.accent" },
  { key: "--accent-light", labelKey: "editor.var.accent-light" },
  { key: "--border", labelKey: "editor.var.border" },
  { key: "--sidebar-bg", labelKey: "editor.var.sidebar-bg" },
  { key: "--sidebar-hover", labelKey: "editor.var.sidebar-hover" },
  { key: "--sidebar-active", labelKey: "editor.var.sidebar-active" },
  { key: "--code-bg", labelKey: "editor.var.code-bg" },
  { key: "--table-border", labelKey: "editor.var.table-border" },
  { key: "--table-stripe", labelKey: "editor.var.table-stripe" },
  { key: "--search-hit", labelKey: "editor.var.search-hit" },
  { key: "--search-hit-active", labelKey: "editor.var.search-hit-active" },
];

// Sanity guard — keeps VAR_META in sync with REQUIRED_VAR_KEYS at runtime.
if (VAR_META.length !== REQUIRED_VAR_KEYS.length) {
  throw new Error("VAR_META is out of sync with REQUIRED_VAR_KEYS");
}

/**
 * Convert a (possibly named/rgb/hsl) CSS color value to a #rrggbb hex string
 * suitable for <input type="color">. Returns null if the input cannot be
 * resolved by the browser (e.g. invalid syntax).
 *
 * Uses a hidden DOM helper so the browser does the parsing: any color string
 * the browser accepts is normalized to its computed `rgb(r, g, b)` form,
 * which we then convert to hex.
 */
export function toHexForPicker(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // Fast path for already-hex values.
  const hex3 = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (hex3) {
    const [r, g, b] = hex3[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const hex6 = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex6) return `#${hex6[1].toLowerCase()}`;

  // Otherwise let the browser parse it.
  if (typeof document === "undefined") return null;
  const probe = document.createElement("div");
  probe.style.color = "";
  probe.style.color = trimmed;
  if (probe.style.color === "") return null; // browser rejected the value
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return rgbStringToHex(computed);
}

function rgbStringToHex(rgb: string): string | null {
  const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(rgb);
  if (!m) return null;
  const r = clamp255(Number(m[1]));
  const g = clamp255(Number(m[2]));
  const b = clamp255(Number(m[3]));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * Slugify an arbitrary string into a safe theme id:
 * lowercase, ASCII letters/digits, dash separators, max 40 chars.
 * Empty input becomes "theme".
 */
export function slugifyId(input: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "theme";
}

/**
 * Given a base id and a set of existing ids, return a unique id by appending
 * "-2", "-3", ... if there's a collision.
 */
export function uniqueId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Restore CSS variables on `root` from a previously taken `snapshot`.
 *
 * For each key:
 * - if the snapshot has a non-empty value, set it inline;
 * - if the snapshot has an empty value (the variable was not set inline when
 *   the snapshot was taken), remove the inline property so the rollback is
 *   complete (it would otherwise leave the preview value applied).
 *
 * Pure function — extracted so the rollback path is unit-tested without main.ts.
 */
export function restoreSnapshotOnto(
  root: HTMLElement,
  snapshot: Readonly<Record<string, string>>,
  keys: readonly string[]
): void {
  const style = root.style;
  for (const k of keys) {
    const v = snapshot[k];
    if (v) {
      style.setProperty(k, v);
    } else {
      style.removeProperty(k);
    }
  }
}

/**
 * Compute the auto-generated theme id from the editor's name field.
 *
 * When `originalId` is provided (editing an existing custom theme in place),
 * that id is excluded from the "taken" set so the field stays stable as long
 * as the name resolves to the same slug — no accidental renaming.
 *
 * Pure function — extracted from the DOM-bound editor handler so it can be
 * unit-tested without a browser.
 */
export function computeAutoId(
  name: string,
  takenIds: ReadonlySet<string>,
  originalId?: string
): string {
  const base = slugifyId(name);
  if (!originalId) return uniqueId(base, takenIds);
  const filtered = new Set(takenIds);
  filtered.delete(originalId);
  return uniqueId(base, filtered);
}
