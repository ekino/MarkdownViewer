// Session = restorable window state across launches.
// Persisted under settings.json key "session". On read, falls back to
// the legacy "lastFolder" key (written by pre-PR1 builds) so existing
// users don't lose their working directory on upgrade.

import { MAX_PATH_LENGTH, type StoreLike } from "./recents";

export interface SessionTab {
  filePath: string;
  scrollY: number;
}

export interface SessionState {
  folder: string | null;
  tabs: SessionTab[];
  activeTabIndex: number;
}

export const SESSION_KEY = "session";
export const LEGACY_FOLDER_KEY = "lastFolder";
// Cap on persisted tabs. The UI doesn't enforce a tab limit, but
// persisting an unbounded list invites runaway growth from buggy callers
// and slow startup when the file watcher revalidates each path.
export const MAX_SESSION_TABS = 32;

export function emptySession(): SessionState {
  return { folder: null, tabs: [], activeTabIndex: -1 };
}

function isValidTab(value: unknown): value is SessionTab {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.filePath !== "string" || v.filePath.length === 0) return false;
  if (v.filePath.length > MAX_PATH_LENGTH) return false;
  const sy = v.scrollY;
  const sp = v.scrollPercent;
  const hasScroll =
    (typeof sy === "number" && Number.isFinite(sy)) ||
    (typeof sp === "number" && Number.isFinite(sp));
  if (!hasScroll) return false;
  return true;
}

export function sanitizeSession(raw: unknown): SessionState {
  if (!raw || typeof raw !== "object") return emptySession();
  const v = raw as Record<string, unknown>;

  const folder =
    typeof v.folder === "string" && v.folder.length > 0 && v.folder.length <= MAX_PATH_LENGTH
      ? v.folder
      : null;

  const tabs: SessionTab[] = Array.isArray(v.tabs)
    ? v.tabs
        .filter(isValidTab)
        .slice(0, MAX_SESSION_TABS)
        .map((t) => {
          const raw = t as unknown as {
            filePath: string;
            scrollY?: number;
            scrollPercent?: number;
          };
          const sy =
            typeof raw.scrollY === "number" && Number.isFinite(raw.scrollY)
              ? raw.scrollY
              : 0;
          return {
            filePath: raw.filePath,
            scrollY: Math.max(0, sy),
          };
        })
    : [];

  let activeTabIndex =
    typeof v.activeTabIndex === "number" && Number.isInteger(v.activeTabIndex)
      ? v.activeTabIndex
      : -1;
  if (activeTabIndex < -1 || activeTabIndex >= tabs.length) {
    activeTabIndex = tabs.length > 0 ? 0 : -1;
  }

  return { folder, tabs, activeTabIndex };
}

export async function loadSession(store: StoreLike): Promise<SessionState> {
  const raw = await store.get(SESSION_KEY);
  if (raw !== null && raw !== undefined) {
    return sanitizeSession(raw);
  }
  // Legacy fallback: pre-PR1 builds stored only the last folder under
  // `lastFolder`. Read it once so upgraders don't see an empty welcome
  // screen on first launch.
  const legacy = await store.get<string>(LEGACY_FOLDER_KEY);
  if (typeof legacy === "string" && legacy.length > 0 && legacy.length <= MAX_PATH_LENGTH) {
    return { folder: legacy, tabs: [], activeTabIndex: -1 };
  }
  return emptySession();
}

export async function saveSession(
  store: StoreLike,
  session: SessionState,
): Promise<void> {
  const sanitized = sanitizeSession(session);
  await store.set(SESSION_KEY, sanitized);
  await store.save();
}
