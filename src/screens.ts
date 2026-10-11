// DOM builders for the screens the navigator commits: home, folder view, the
// sidebar's file list and the breadcrumb. They build detached nodes from plain
// data and callbacks, so a failure leaves the page untouched and they can be
// tested without the app. Every name and path goes in as text, never as HTML.

import { iconEl, type IconName } from "./icons";
import { t } from "./i18n";
import type { Entry, Listing, RecentEntry } from "./utils";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, onClick: () => void, iconName?: IconName): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  if (iconName) b.append(iconEl(iconName));
  b.append(el("span", "btn-label", label));
  b.addEventListener("click", onClick);
  return b;
}

/** Keyboard shortcut drawn as key caps, e.g. ["⇧", "⌘", "O"]. */
export function keycaps(keys: string[], className = "keycaps"): HTMLElement {
  const wrap = el("span", className);
  wrap.setAttribute("aria-hidden", "true");
  for (const k of keys) wrap.append(el("kbd", "keycap", k));
  return wrap;
}

function format(key: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t(key));
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function parentLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const home = /^\/Users\/[^/]+/;
  return ("/" + parts.join("/")).replace(home, "~");
}

// --- Home ---

export type ResumeStatus = "ok" | "missing" | "denied";

export interface HomeData {
  /** No recents and nothing read yet: explain the app. */
  firstRun: boolean;
  /** Folder still open in this window, if any. */
  kept: { name: string; accessible: boolean } | null;
  resume: { title: string; file: string; rootName: string; status: ResumeStatus } | null;
  recents: RecentEntry[];
}

export interface HomeActions {
  resume(): void;
  openFolder(): void;
  openFile(): void;
  openExamples(): void;
  openRecent(entry: RecentEntry): void;
  clearRecents(): void;
  returnToFolder(): void;
  closeFolder(): void;
  openResumeFolder(): void;
}

export function buildHome(data: HomeData, actions: HomeActions): HTMLElement {
  const root = el("div", "home-inner");
  if (data.firstRun) root.classList.add("first-run");

  if (data.kept) {
    const banner = el("div", "card kept-banner");
    banner.setAttribute("role", "status");
    const text = el("span", "kept-text");
    text.textContent = format(data.kept.accessible ? "home.kept" : "home.kept.inaccessible", {
      name: data.kept.name,
    });
    banner.append(text);
    if (data.kept.accessible) {
      banner.append(button("btn btn-primary btn-small", t("home.kept.return"), actions.returnToFolder));
    }
    banner.append(button("btn btn-link", t("folder.close"), actions.closeFolder));
    root.append(banner);
  }

  const header = el("header", "home-header");
  const mark = el("span", "app-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.append(el("span", "app-mark-face", "M↓"));
  const titles = el("div", "home-titles");
  titles.append(el("h1", "home-title", t("app.name")), el("p", "home-tagline", t("home.tagline")));
  header.append(mark, titles);
  root.append(header);

  const grid = el("div", "home-grid");
  if (!data.firstRun) {
    const left = el("div", "home-col");
    if (data.resume) left.append(buildResume(data.resume, actions));
    if (data.recents.length > 0) left.append(buildRecents(data.recents, actions));
    grid.append(left);
  }
  grid.append(buildOpenCard(data.firstRun, actions));
  root.append(grid);
  return root;
}

function buildResume(resume: NonNullable<HomeData["resume"]>, actions: HomeActions): HTMLElement {
  const ok = resume.status === "ok";
  const card = el("section", ok ? "card resume-card" : "card resume-card resume-card--missing");
  card.setAttribute("aria-labelledby", "resume-label");
  const body = el("div", "resume-body");
  const label = el("span", "eyebrow", ok ? t("home.resume") : t(`home.resume.${resume.status}`));
  label.id = "resume-label";
  body.append(
    label,
    el("span", "resume-title", resume.title),
    el("span", "resume-path mono", ok ? `${resume.rootName}/${resume.file}` : t(`home.resume.${resume.status}.hint`))
  );
  card.append(body);
  if (ok) {
    const go = button("btn btn-resume", t("home.resume.button"), actions.resume);
    go.append(iconEl("arrowRight"));
    card.append(go);
  } else {
    card.append(button("btn btn-secondary", t("home.resume.openFolder"), actions.openResumeFolder));
  }
  return card;
}

function buildRecents(recents: RecentEntry[], actions: HomeActions): HTMLElement {
  const card = el("section", "card recents-card");
  card.setAttribute("aria-labelledby", "recents-label");
  const head = el("div", "card-head");
  const h = el("h2", "eyebrow", t("home.recents"));
  h.id = "recents-label";
  head.append(h, button("btn btn-link", t("home.recents.clear"), actions.clearRecents));
  const list = el("ul", "recents-list");
  for (const entry of recents) {
    const li = el("li");
    const b = el("button", "recent-item");
    b.type = "button";
    const tile = el("span", `recent-tile recent-tile--${entry.kind}`);
    tile.append(iconEl(entry.kind === "folder" ? "folder" : "file"));
    const text = el("span", "recent-text");
    text.append(el("span", "recent-name", baseName(entry.path)), el("span", "recent-path mono", parentLabel(entry.path)));
    b.append(tile, text);
    b.setAttribute("aria-label", `${baseName(entry.path)} — ${t(`home.recent.${entry.kind}`)}`);
    b.addEventListener("click", () => actions.openRecent(entry));
    li.append(b);
    list.append(li);
  }
  card.append(head, list);
  return card;
}

function buildOpenCard(firstRun: boolean, actions: HomeActions): HTMLElement {
  const col = el("div", "home-col home-col--open");
  const card = el("section", "card open-card");
  card.setAttribute("aria-labelledby", "open-label");
  const h = el("h2", "eyebrow", t(firstRun ? "home.start" : "home.open"));
  h.id = "open-label";
  card.append(h);
  if (firstRun) card.append(el("p", "open-intro", t("home.start.text")));

  const folderBtn = button(firstRun ? "btn btn-ink btn-wide" : "btn btn-cream btn-wide", t("home.openFolder"), actions.openFolder);
  folderBtn.append(keycaps(["⇧", "⌘", "O"]));
  const fileBtn = button("btn btn-cream btn-wide", t("home.openFile"), actions.openFile);
  fileBtn.append(keycaps(["⌘", "O"]));
  card.append(folderBtn, fileBtn);
  if (firstRun) {
    const ex = button("btn btn-cream btn-wide", t("home.examples"), actions.openExamples);
    ex.append(iconEl("arrowRight"));
    card.append(ex);
  }
  const drop = el("div", "drop-zone");
  drop.append(el("span", "drop-title", t("home.drop")), el("span", "drop-types mono", t("home.drop.types")));
  card.append(drop);

  const hint = el("p", "home-shortcut");
  hint.append(el("span", undefined, t("home.shortcut")), keycaps(["⇧", "⌘", "H"], "keycaps keycaps--big"));
  col.append(card, hint);
  return col;
}

// --- Folder view ---

export interface FolderData {
  rootName: string;
  dir: string[];
  listing: Listing;
  readme: string | null;
}

export interface FolderActions {
  open(entry: Entry): void;
  openReadme(): void;
  openOther(): void;
}

export function buildFolderView(data: FolderData, actions: FolderActions): HTMLElement {
  const root = el("div", "folder-inner");
  const header = el("header", "folder-header");
  const titles = el("div", "folder-titles");
  const files = data.listing.entries.filter((e) => e.kind === "file").length;
  titles.append(
    el("span", "eyebrow", `${t("folder.label")} · ${format("folder.count", { n: String(files) })}`),
    el("h1", "folder-title", data.dir.length ? data.dir[data.dir.length - 1] : data.rootName)
  );
  header.append(titles);
  if (data.readme) {
    header.append(button("btn btn-ink", t("folder.readme"), actions.openReadme));
  }
  root.append(header);

  const message = folderMessage(data.listing);
  if (message) {
    const box = el("div", "card folder-message");
    box.append(el("p", undefined, message));
    if (data.listing.status !== "ok") {
      box.append(button("btn btn-cream", t("folder.openOther"), actions.openOther));
    }
    root.append(box);
    return root;
  }

  const grid = el("ul", "folder-grid");
  for (const entry of data.listing.entries) {
    const li = el("li");
    const b = el("button", "tile");
    b.type = "button";
    b.title = entry.name;
    const isReadme = entry.name === data.readme;
    if (isReadme) b.classList.add("tile--readme");
    if (entry.kind === "directory") b.classList.add("tile--dir");
    const head = el("span", "tile-head");
    head.append(iconEl(entry.kind === "directory" ? "folder" : isReadme ? "readme" : "file"));
    head.append(el("span", "tile-name mono", entry.name));
    b.append(head);
    if (entry.kind === "directory") b.append(el("span", "tile-hint", t("folder.subfolder")));
    b.addEventListener("click", () => actions.open(entry));
    li.append(b);
    grid.append(li);
  }
  root.append(grid);
  return root;
}

export function folderMessage(listing: Listing): string | null {
  if (listing.status !== "ok") return t(`folder.${listing.status}`);
  if (listing.rawCount === 0) return t("folder.empty");
  if (listing.entries.length === 0) return t("folder.noMarkdown");
  return null;
}

// --- Sidebar ---

export interface FileListActions {
  open(entry: Entry): void;
  up(): void;
}

/** The sidebar's list for one folder: a way up, subfolders, then documents. */
export function buildFileList(
  listing: Listing,
  inSubfolder: boolean,
  activeName: string | null,
  readme: string | null,
  actions: FileListActions
): HTMLElement {
  const list = el("ul", "file-list-items");
  if (inSubfolder) {
    const li = el("li");
    const up = el("button", "file-item file-item--up");
    up.type = "button";
    up.append(iconEl("up"), el("span", "name", t("sidebar.parent")));
    up.addEventListener("click", actions.up);
    li.append(up);
    list.append(li);
  }
  if (listing.status !== "ok") {
    const li = el("li", "file-list-message", t(`folder.${listing.status}`));
    list.append(li);
    return list;
  }
  for (const entry of listing.entries) {
    const li = el("li");
    const b = el("button", "file-item");
    b.type = "button";
    const isReadme = entry.name === readme;
    b.append(iconEl(entry.kind === "directory" ? "folder" : isReadme ? "readme" : "file"));
    b.append(el("span", "name", entry.name));
    if (entry.kind === "file" && entry.name === activeName) {
      b.classList.add("active");
      b.setAttribute("aria-current", "page");
    }
    b.addEventListener("click", () => actions.open(entry));
    li.append(b);
    list.append(li);
  }
  return list;
}

// --- Breadcrumb ---

/** Root, then each folder of `dir`, then the document name (not a link). */
export function buildBreadcrumb(
  rootName: string,
  dir: string[],
  file: string | null,
  currentIsFolder: boolean,
  openDir: (depth: number) => void
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = [rootName, ...dir];
  parts.forEach((name, depth) => {
    if (depth > 0) frag.append(sep());
    const isCurrent = currentIsFolder && depth === parts.length - 1;
    const b = el("button", "crumb", name);
    b.type = "button";
    if (isCurrent) b.setAttribute("aria-current", "page");
    b.addEventListener("click", () => openDir(depth));
    frag.append(b);
  });
  if (file) {
    frag.append(sep());
    const current = el("span", "crumb crumb--doc mono", file);
    current.setAttribute("aria-current", "page");
    frag.append(current);
  }
  return frag;
}

function sep(): HTMLElement {
  const s = el("span", "crumb-sep");
  s.setAttribute("aria-hidden", "true");
  s.append(iconEl("chevronRight", 13));
  return s;
}
