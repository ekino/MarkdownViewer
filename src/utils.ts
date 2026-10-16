export interface Entry {
  name: string;
  kind: "directory" | "file";
}

/**
 * Resolve a relative path against a base directory path.
 * Handles `..`, `.`, and empty segments.
 */
export function resolvePath(base: string[], relative: string): string {
  const parts = [...base];
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Build a full filesystem path from a root and path segments.
 */
export function getFullPath(
  rootPath: string,
  pathParts: string[]
): string {
  if (pathParts.length === 0) return rootPath;
  return `${rootPath}/${pathParts.join("/")}`;
}

/**
 * The last name in a path, trailing slash or not; `/` for the volume root.
 */
export function extractRootName(path: string): string {
  const name = path.split("/").filter(Boolean).pop();
  if (name) return name;
  return path.startsWith("/") ? "/" : "root";
}

/** A path with the home folder written `~`: `/Users/me/dev` → `~/dev`. */
export function tildePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** Where a file or folder sits, written short: `/Users/me/dev/mdv` → `~/dev`. */
export function parentLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  // The volume root sits nowhere: its name says it all.
  if (parts.length === 0) return "";
  parts.pop();
  return tildePath("/" + parts.join("/"));
}

/** Extensions the app opens: the same list the Finder association and ⌘O accept. */
export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdx"];

/** True for a path or name ending in a Markdown extension, whatever its case. */
export function isMarkdownName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return MARKDOWN_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/**
 * Filter and sort raw directory entries into sorted dirs-first entries.
 * Only includes directories and Markdown files, excludes dotfiles.
 */
export function filterAndSortEntries(
  rawEntries: { name: string | undefined; isDirectory: boolean }[]
): Entry[] {
  const dirs: Entry[] = [];
  const files: Entry[] = [];

  for (const entry of rawEntries) {
    if (!entry.name || entry.name.startsWith(".")) continue;
    if (entry.isDirectory) {
      dirs.push({ name: entry.name, kind: "directory" });
    } else if (isMarkdownName(entry.name)) {
      files.push({ name: entry.name, kind: "file" });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

export type ListingStatus = "ok" | "missing" | "denied" | "error";

/** A folder as the folder view and the sidebar show it. */
export interface Listing {
  status: ListingStatus;
  /** Visible entries before keeping only folders and Markdown files. */
  rawCount: number;
  entries: Entry[];
}

export function summarizeListing(
  rawEntries: { name: string | undefined; isDirectory: boolean }[]
): Listing {
  const rawCount = rawEntries.filter((e) => e.name && !e.name.startsWith(".")).length;
  return { status: "ok", rawCount, entries: filterAndSortEntries(rawEntries) };
}

/** Map a failed directory read to what the folder view tells the reader. */
export function listingStatusFromError(error: unknown): ListingStatus {
  const text = String(error).toLowerCase();
  // Prefer the errno when present: "os error 20" (not a directory) must not
  // read as "os error 2" (no such file).
  const errno = /os error (\d+)/.exec(text);
  if (errno) {
    const code = Number(errno[1]);
    if (code === 2) return "missing";
    if (code === 1 || code === 13) return "denied";
    return "error";
  }
  if (text.includes("no such file") || text.includes("not found")) return "missing";
  if (text.includes("permission") || text.includes("denied")) return "denied";
  return "error";
}

/**
 * Classify a link href for handling.
 */
export function classifyLink(
  href: string
): "external" | "anchor" | "markdown" | "other" {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return "external";
  }
  if (href.startsWith("#")) {
    return "anchor";
  }
  if (isMarkdownName(href.split("#")[0])) {
    return "markdown";
  }
  return "other";
}

/**
 * Parse a markdown link href into file part and optional anchor, both decoded:
 * `My%20Guide.md` names the file `My Guide.md`.
 */
export function parseMarkdownHref(
  href: string
): { filePart: string; anchor: string | undefined } {
  const [rawFile, rawAnchor] = href.split("#");
  return { filePart: decodePathPart(rawFile), anchor: decodeAnchor(rawAnchor) };
}

/**
 * A percent-encoded path, decoded; a malformed escape (`100%.md`) is used as
 * written. Known limit: a valid escape is always decoded, so a file whose name
 * holds one literally (`50%20off.md`) must be linked as `50%2520off.md`.
 */
export function decodePathPart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `#` alone means no anchor; an undecodable fragment is used as written. */
export function decodeAnchor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return decodePathPart(raw);
}

/**
 * Find a README.md entry (case-insensitive) in a list of entries.
 */
export function findReadme(entries: Entry[]): Entry | undefined {
  return entries.find(
    (e) => e.kind === "file" && e.name.toLowerCase() === "readme.md"
  );
}

/** What the Rust `get_pending_open` command buffered for this window. */
export type PendingOpen =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "empty" };

/** What a window should display right after init. */
export type InitialView =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "welcome" };

/**
 * Decide what a window shows on startup.
 *
 * A pending open (CLI arg, Finder "Open With", or a folder handed to a freshly
 * spawned window) always wins over the persisted folder, so the user never sees
 * a flash of the previous folder. `kind: "empty"` is the marker for a window
 * spawned by "New Window": it must land on the welcome screen rather than
 * restoring `lastFolder`, otherwise it would just clone the window it came from.
 */
export function resolveInitialView(
  pending: PendingOpen | null,
  savedFolder: string | null,
  reopenLastFolder = false
): InitialView {
  if (pending) {
    if (pending.kind === "file") return { kind: "file", path: pending.path };
    if (pending.kind === "folder") return { kind: "folder", path: pending.path };
    return { kind: "welcome" };
  }
  // The last folder comes back only when the reader asked for it in the
  // preferences; otherwise the app opens on the home screen ("Reprendre").
  if (savedFolder && reopenLastFolder) return { kind: "folder", path: savedFolder };
  return { kind: "welcome" };
}

export const DEFAULT_WINDOW_TITLE = "Markdown Viewer";

/**
 * Native title for a window, used by the macOS Window menu to label the entry
 * it adds per window (the title itself stays hidden in the custom title bar).
 *
 * Most specific thing first: the open document, else the folder being browsed,
 * else the app name for a window still on the welcome screen.
 */
export function windowTitle(
  activeFile: string | null,
  rootName: string
): string {
  const fileName = activeFile?.split("/").pop();
  if (fileName) return fileName;
  if (rootName) return rootName;
  return DEFAULT_WINDOW_TITLE;
}

export type RecentEntry = { path: string; kind: "file" | "folder" };

/**
 * Prepend an entry to the recents list, dropping any prior entry with the same
 * path (most-recent-wins) and capping the list length.
 */
export function mergeRecent(
  list: RecentEntry[],
  entry: RecentEntry,
  max: number
): RecentEntry[] {
  return [entry, ...list.filter((e) => e.path !== entry.path)].slice(0, max);
}

/** The last document read, across windows: what "Reprendre" offers on the home screen. */
export interface LastRead {
  rootPath: string;
  file: string;
  title: string;
  scrollTop: number;
  /** Time of the last reading activity (opening the document or scrolling it). */
  at: number;
}

export function isLastRead(value: unknown): value is LastRead {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.rootPath === "string" &&
    typeof v.file === "string" &&
    typeof v.title === "string" &&
    typeof v.scrollTop === "number" &&
    typeof v.at === "number"
  );
}

/** Never let an older reading activity overwrite a newer one written by another window. */
export function shouldWriteLastRead(stored: unknown, next: LastRead): boolean {
  if (!isLastRead(stored)) return true;
  if (stored.rootPath === next.rootPath && stored.file === next.file) {
    return next.at >= stored.at;
  }
  return next.at > stored.at;
}
