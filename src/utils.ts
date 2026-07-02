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
 * Extract the folder name from an absolute path.
 */
export function extractRootName(path: string): string {
  return path.split("/").pop() || "root";
}

/**
 * Filter and sort raw directory entries into sorted dirs-first entries.
 * Only includes directories and .md files, excludes dotfiles.
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
    } else if (entry.name.endsWith(".md")) {
      files.push({ name: entry.name, kind: "file" });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
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
  if (href.endsWith(".md") || href.includes(".md#")) {
    return "markdown";
  }
  return "other";
}

/**
 * Parse a markdown link href into file part and optional anchor.
 */
export function parseMarkdownHref(
  href: string
): { filePart: string; anchor: string | undefined } {
  const [filePart, anchor] = href.split("#");
  return { filePart, anchor };
}

/**
 * Find a README.md entry (case-insensitive) in a list of entries.
 */
export function findReadme(entries: Entry[]): Entry | undefined {
  return entries.find(
    (e) => e.kind === "file" && e.name.toLowerCase() === "readme.md"
  );
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
