// Recents = a single mixed list of recently opened files and folders.
// Persisted under settings.json key "recents", capped at MAX_RECENTS.
// Missing-on-disk state is computed at runtime via the `validate_paths`
// Rust command and never persisted, so a temporarily unmounted volume
// doesn't permanently dim entries.

export type RecentKind = "file" | "folder";

export interface RecentEntry {
  kind: RecentKind;
  path: string;
  displayName: string;
  lastOpenedAt: number;
}

export const RECENTS_KEY = "recents";
export const MAX_RECENTS = 10;
// 4 KiB matches the practical upper bound for filesystem paths on all
// supported OSes (PATH_MAX on macOS/Linux is 1024-4096; Windows long
// paths cap at ~32767 but anything that long is almost certainly
// hostile or a bug).
export const MAX_PATH_LENGTH = 4096;

// Minimal subset of the tauri-plugin-store Store interface that this
// module needs. Declared locally so tests can pass an in-memory stub
// without dragging in the plugin.
export interface StoreLike {
  get<T = unknown>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

export function isValidRecent(value: unknown): value is RecentEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind !== "file" && v.kind !== "folder") return false;
  if (typeof v.path !== "string" || v.path.length === 0) return false;
  if (v.path.length > MAX_PATH_LENGTH) return false;
  if (typeof v.displayName !== "string") return false;
  if (typeof v.lastOpenedAt !== "number" || !Number.isFinite(v.lastOpenedAt)) {
    return false;
  }
  return true;
}

export function sanitizeRecents(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isValidRecent(item)) continue;
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: item.kind,
      path: item.path,
      displayName: item.displayName,
      lastOpenedAt: item.lastOpenedAt,
    });
    if (out.length >= MAX_RECENTS) break;
  }
  return out;
}

export async function loadRecents(store: StoreLike): Promise<RecentEntry[]> {
  const raw = await store.get(RECENTS_KEY);
  return sanitizeRecents(raw);
}

export async function saveRecents(
  store: StoreLike,
  recents: RecentEntry[],
): Promise<void> {
  await store.set(RECENTS_KEY, recents.slice(0, MAX_RECENTS));
  await store.save();
}

// Push a new entry to the front, dedupe by (kind,path), cap at MAX_RECENTS.
// Returns the new array — caller persists.
export function pushRecent(
  current: readonly RecentEntry[],
  entry: RecentEntry,
): RecentEntry[] {
  if (!isValidRecent(entry)) return [...current];
  const key = `${entry.kind}:${entry.path}`;
  const filtered = current.filter((r) => `${r.kind}:${r.path}` !== key);
  return [entry, ...filtered].slice(0, MAX_RECENTS);
}

export function clearRecents(): RecentEntry[] {
  return [];
}
