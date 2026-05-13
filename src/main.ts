import DOMPurify from "dompurify";
import mermaid from "mermaid";
import "katex/dist/katex.min.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { load } from "@tauri-apps/plugin-store";
import { confirmDialog } from "./confirm-dialog";
import { addCopyButtons, addImageLightbox } from "./dom";
import { trapFocus, type FocusTrap } from "./focus-trap";
import {
  LOCALE_KEY,
  applyTranslations,
  getLocale,
  isLocale,
  resolveInitialLocale,
  setLocale,
  t,
  type Locale,
} from "./i18n";
import { parseMarkdown } from "./markdown";
import {
  loadRecents as loadRecentsFromStore,
  pushRecent,
  saveRecents,
  type RecentEntry,
} from "./recents";
import { loadSession, saveSession } from "./session";
import { runExport, type ExportFormat } from "./export";
import { SidebarTree, type ScanResult } from "./sidebar-tree";
import { TabManager, type Tab } from "./tabs";
import { showToast } from "./toast";
import {
  renderRecentsList,
  showContextMenu,
  updateWelcomeVisibility,
  type RecentDisplayEntry,
} from "./welcome";
import {
  APPEARANCE_KEY,
  BODY_FONT_KEY,
  CODE_FONT_KEY,
  CUSTOM_FONT_SIZE_KEY,
  FONTSIZE_KEY,
  FONT_WEIGHT_KEY,
  MAX_CUSTOM_FONT_SIZE,
  MIN_CUSTOM_FONT_SIZE,
  OUTLINE_PREF_KEY,
  applyBodyFontToDOM,
  applyCodeFontToDOM,
  applyCustomFontSizeToDOM,
  applyFontSizeToDOM,
  applyFontWeightToDOM,
  applyOutlinePrefToDOM,
  resolveInitialCustomFontSize,
  resolveInitialFontFamily,
  resolveInitialFontSize,
  resolveInitialFontWeight,
  resolveInitialOutlinePref,
  setSegmentActive,
  type FontSize,
  type FontWeight,
  type OutlinePref,
} from "./preferences";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_ORDER,
  CUSTOM_THEMES_KEY,
  FOLLOW_SYSTEM_KEY,
  REQUIRED_VAR_KEYS,
  THEME_KEY,
  applyThemeToDOM,
  buildThemeCatalog,
  isTheme,
  mergeCustomThemes,
  parseTheme,
  resolveActiveThemeId,
  resolveInitialThemeId,
  sanitizeCustomThemes,
  type Theme,
  type ThemeId,
} from "./themes";
import {
  VAR_META,
  computeAutoId,
  restoreSnapshotOnto,
  toHexForPicker,
} from "./theme-editor";
import { createSearchController, type SearchController } from "./search";
import type { Entry } from "./utils";
import {
  classifyLink,
  extractRootName,
  filterAndSortEntries,
  findReadme,
  getFullPath,
  parseMarkdownHref,
  resolvePath,
} from "./utils";

// --- Theme & preferences management ---

const themeToggle = document.getElementById(
  "theme-toggle"
) as HTMLButtonElement;

let currentThemeId: ThemeId = "light";
let followSystem = false;
let customThemes: Theme[] = [];
let themeCatalog: Record<ThemeId, Theme> = { ...BUILTIN_THEMES };
let currentBodyFont: string | null = null;
let currentCodeFont: string | null = null;
let currentFontWeight: FontWeight | null = null;
let currentCustomFontSize: number | null = null;
const systemDarkMQ = window.matchMedia("(prefers-color-scheme: dark)");

function isDark(): boolean {
  return themeCatalog[activeThemeId()]?.isDark ?? false;
}

function activeThemeId(): ThemeId {
  return resolveActiveThemeId(
    themeCatalog,
    currentThemeId,
    followSystem,
    systemDarkMQ.matches
  );
}

// Pass every mermaid-produced SVG through DOMPurify before it lands in
// the live DOM. Mermaid 10/11 with securityLevel:"strict" already drops
// most XSS vectors, but historical CVEs (e.g. CVE-2021-23648) prove the
// SVG output is not a trust boundary on its own. Allowing the standard
// SVG profile keeps gradients, animations, and foreign-object text that
// real diagrams need.
function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  }) as unknown as string;
}

function applyActiveTheme(): void {
  const id = activeThemeId();
  applyThemeToDOM(themeCatalog, document.documentElement, id);
  const dark = themeCatalog[id]?.isDark ?? false;
  themeToggle.textContent = dark ? "\u2600\uFE0F" : "\u{1F319}";
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    // `strict` blocks user-supplied click handlers and HTML labels inside
    // mermaid blocks. We additionally sanitize the rendered SVG below as
    // defense-in-depth, since past mermaid releases have shipped XSS
    // bugs even at this level.
    securityLevel: "strict",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });
}

function applyFontSize(size: FontSize): void {
  applyFontSizeToDOM(document.documentElement, size);
}

function applyOutlinePref(pref: OutlinePref): void {
  applyOutlinePrefToDOM(document.documentElement, pref);
}

systemDarkMQ.addEventListener("change", () => {
  if (followSystem) {
    applyActiveTheme();
    refreshThemeGridSelection();
  }
});

async function initTheme(): Promise<void> {
  const store = await load(STORE_FILE);
  const savedThemeId = await store.get(THEME_KEY);
  const savedAppearance = await store.get(APPEARANCE_KEY);
  const savedFollow = await store.get(FOLLOW_SYSTEM_KEY);
  const savedFontSize = resolveInitialFontSize(await store.get(FONTSIZE_KEY));
  const savedOutline = resolveInitialOutlinePref(
    await store.get(OUTLINE_PREF_KEY)
  );

  const storeCustoms = sanitizeCustomThemes(
    await store.get(CUSTOM_THEMES_KEY)
  );
  let diskCustoms: Theme[] = [];
  try {
    const raw = await invoke<unknown[]>("list_disk_themes");
    diskCustoms = raw.filter(isTheme).map((t) => ({ ...t, custom: true }));
  } catch (e) {
    console.warn("Failed to read disk themes:", e);
  }
  customThemes = mergeCustomThemes(storeCustoms, diskCustoms);
  themeCatalog = buildThemeCatalog(customThemes);
  currentThemeId = resolveInitialThemeId(
    themeCatalog,
    savedThemeId,
    savedAppearance
  );
  followSystem = savedFollow === true;
  currentBodyFont = resolveInitialFontFamily(await store.get(BODY_FONT_KEY));
  currentCodeFont = resolveInitialFontFamily(await store.get(CODE_FONT_KEY));
  currentFontWeight = resolveInitialFontWeight(
    await store.get(FONT_WEIGHT_KEY)
  );
  currentCustomFontSize = resolveInitialCustomFontSize(
    await store.get(CUSTOM_FONT_SIZE_KEY)
  );

  applyActiveTheme();
  applyFontSize(savedFontSize);
  applyOutlinePref(savedOutline);
  applyBodyFontToDOM(document.documentElement, currentBodyFont);
  applyCodeFontToDOM(document.documentElement, currentCodeFont);
  applyFontWeightToDOM(document.documentElement, currentFontWeight);
  applyCustomFontSizeToDOM(document.documentElement, currentCustomFontSize);
}

// --- Print / PDF export ---

import { invoke } from "@tauri-apps/api/core";

const printBtn = document.getElementById("print-btn") as HTMLButtonElement;
printBtn.addEventListener("click", () => {
  invoke("print_webview");
});

const pdfBtn = document.getElementById("pdf-btn") as HTMLButtonElement;
pdfBtn.addEventListener("click", async () => {
  const defaultName = activeFile
    ? activeFile.split("/").pop()!.replace(/\.md$/i, ".pdf")
    : "document.pdf";

  const outputPath = await save({
    defaultPath: defaultName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!outputPath) return;

  document.body.classList.add("print-mode");
  try {
    await new Promise((r) => setTimeout(r, 150));
    await invoke("export_pdf", { outputPath });
  } finally {
    document.body.classList.remove("print-mode");
  }
});

// Save / Export — wired by the native File menu.
//
// Tauri's save() doesn't show a format picker inside the OS dialog, so
// instead of one ambiguous "Save As" we expose one menu item per format
// (each with its own single-filter native dialog). ⌘S replays whichever
// format the user last picked for the active file.
const lastExportFormatByFile = new Map<string, ExportFormat>();

const FORMAT_FILTER: Record<ExportFormat, { name: string; ext: string }> = {
  pdf: { name: "PDF", ext: "pdf" },
  "html-standalone": { name: "HTML (standalone)", ext: "html" },
  "html-with-assets": { name: "HTML + assets", ext: "html" },
  "md-copy": { name: "Markdown source", ext: "md" },
};

function activeAbsoluteFile(): string | null {
  return absoluteActiveFile();
}

function activeDefaultStem(): string {
  if (!activeFile) return "document";
  const name = activeFile.split("/").pop() ?? "document.md";
  return name.replace(/\.[^.]+$/, "");
}

async function exportAs(format: ExportFormat): Promise<void> {
  const sourcePath = activeAbsoluteFile();
  if (!sourcePath) return;
  const filter = FORMAT_FILTER[format];
  const outputPath = await save({
    defaultPath: `${activeDefaultStem()}.${filter.ext}`,
    filters: [{ name: filter.name, extensions: [filter.ext] }],
  });
  if (!outputPath) return;
  await performExport(format, sourcePath, outputPath);
}

async function runSave(): Promise<void> {
  const sourcePath = activeAbsoluteFile();
  if (!sourcePath) return;
  // First save on this file → fall back to PDF, the most common choice.
  const format = lastExportFormatByFile.get(sourcePath) ?? "pdf";
  await exportAs(format);
}

async function performExport(
  format: ExportFormat,
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  // The PDF pipeline needs the print-mode body class around the WKWebView
  // capture, just like the existing PDF button flow.
  const wantsPdf = format === "pdf";
  if (wantsPdf) document.body.classList.add("print-mode");
  try {
    if (wantsPdf) await new Promise((r) => setTimeout(r, 150));
    await runExport(
      format,
      {
        sourcePath,
        rootPath,
        markdownEl,
        defaultStem: activeDefaultStem(),
      },
      {
        // We provide the outputPath directly via a stub save() that
        // returns it unchanged — runExport's save() prompt was already
        // handled by runSave/runSaveAs above.
        save: async () => outputPath,
        invoke: invoke as unknown as (
          cmd: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>,
      },
    );
    lastExportFormatByFile.set(sourcePath, format);
  } catch (e) {
    console.error("Export failed:", e);
    showToast(`Export failed: ${e}`, "error");
  } finally {
    if (wantsPdf) document.body.classList.remove("print-mode");
  }
}

// macOS Share — only invokable from the menu on macOS; on other OSes
// the menu item isn't rendered, so this handler is a no-op fallback.
async function runShare(): Promise<void> {
  const sourcePath = activeAbsoluteFile();
  if (!sourcePath) return;
  // Anchor the share sheet to the top-right of the titlebar (rough but
  // adequate — sanitize_rect on the Rust side clamps to the view).
  const rect = { x: window.innerWidth - 80, y: 8, width: 32, height: 24 };
  try {
    await invoke("share_macos", { paths: [sourcePath], anchor: rect });
  } catch (e) {
    console.warn("share_macos failed:", e);
  }
}

themeToggle.addEventListener("click", async () => {
  const activeId = activeThemeId();
  const newId = themeCatalog[activeId]?.pair ?? activeId;
  currentThemeId = newId;
  followSystem = false;
  applyActiveTheme();
  const store = await load(STORE_FILE);
  await store.set(THEME_KEY, newId);
  await store.set(FOLLOW_SYSTEM_KEY, false);
  await store.save();
  syncPrefsUI();
  refreshThemeGridSelection();
});

let mermaidCounter = 0;

async function renderMermaidDiagrams(): Promise<void> {
  const codeBlocks = markdownEl.querySelectorAll("pre > code.language-mermaid");
  if (codeBlocks.length === 0) return;

  for (const codeBlock of codeBlocks) {
    const pre = codeBlock.parentElement!;
    const source = codeBlock.textContent ?? "";
    const id = `mermaid-${++mermaidCounter}`;

    let title = "Diagram";
    const prevEl = pre.previousElementSibling;
    if (prevEl && /^H[2-4]$/.test(prevEl.tagName)) {
      title = prevEl.textContent ?? "Diagram";
    }

    try {
      const { svg } = await mermaid.render(id, source);

      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-wrapper";

      const btn = document.createElement("button");
      btn.className = "mermaid-fullscreen-btn";
      btn.innerHTML = "<span>&#x26F6;</span> Fullscreen";
      btn.addEventListener("click", () => openMermaidFullscreen(svg, title));

      const preview = document.createElement("div");
      preview.className = "mermaid-preview";
      preview.innerHTML = sanitizeMermaidSvg(svg);

      wrapper.appendChild(btn);
      wrapper.appendChild(preview);
      pre.replaceWith(wrapper);

      // Dynamic height: fit SVG content, cap at 80vh
      requestAnimationFrame(() => {
        const svgEl = preview.querySelector("svg");
        if (svgEl) {
          const naturalHeight = svgEl.getBoundingClientRect().height;
          const maxHeight = window.innerHeight * 0.8;
          preview.style.maxHeight =
            naturalHeight > maxHeight ? `${maxHeight}px` : "none";
        }
      });
    } catch (e) {
      console.warn("Mermaid render failed for diagram", id, e);
      const errWrapper = document.createElement("div");
      errWrapper.className = "mermaid-wrapper";
      errWrapper.style.borderColor = "#ef4444";
      const errMsg = document.createElement("div");
      errMsg.style.cssText = "padding:12px 16px;font-size:12px;color:#ef4444;";
      errMsg.textContent = t("mermaid.error");
      const srcPre = document.createElement("pre");
      srcPre.style.cssText = "margin:0;border-radius:0 0 8px 8px;";
      const srcCode = document.createElement("code");
      srcCode.textContent = source;
      srcPre.appendChild(srcCode);
      errWrapper.appendChild(errMsg);
      errWrapper.appendChild(srcPre);
      pre.replaceWith(errWrapper);
      document.getElementById(id)?.remove();
    }
  }
}

function openImageOverlay(img: HTMLImageElement): void {
  const overlay = document.createElement("div");
  overlay.className = "image-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  // Make the overlay itself focusable so the trap has at least one target
  // (there are no interactive children).
  overlay.tabIndex = 0;

  const fullImg = document.createElement("img");
  fullImg.src = img.src;
  fullImg.alt = img.alt;
  fullImg.className = "image-overlay-img";

  overlay.appendChild(fullImg);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add("visible"));
  const trap = trapFocus(overlay);

  function closeOverlay() {
    overlay.classList.remove("visible");
    document.removeEventListener("keydown", onKeyDown);
    trap.release();
    setTimeout(() => overlay.remove(), 200);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") closeOverlay();
  }

  document.addEventListener("keydown", onKeyDown);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeOverlay();
  });
}

function openMermaidFullscreen(svgContent: string, title: string): void {
  const overlay = document.createElement("div");
  overlay.className = "mermaid-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "mermaid-overlay-header";

  const titleEl = document.createElement("div");
  titleEl.className = "mermaid-overlay-title";
  titleEl.textContent = title;

  const closeBtn = document.createElement("button");
  closeBtn.className = "mermaid-overlay-close";
  closeBtn.textContent = t("mermaid.close");
  closeBtn.addEventListener("click", () => closeOverlay());

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "mermaid-overlay-body";
  body.innerHTML = sanitizeMermaidSvg(svgContent);

  const svg = body.querySelector("svg");
  if (svg) {
    svg.removeAttribute("width");
    svg.style.maxWidth = "95vw";
    svg.style.height = "auto";
  }

  overlay.appendChild(header);
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add("visible"));
  const trap = trapFocus(overlay);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") closeOverlay();
  }
  document.addEventListener("keydown", onKeyDown);

  function closeOverlay() {
    overlay.classList.remove("visible");
    document.removeEventListener("keydown", onKeyDown);
    trap.release();
    setTimeout(() => overlay.remove(), 200);
  }
}

const fileList = document.getElementById("file-list") as HTMLDivElement;
const breadcrumb = document.getElementById("breadcrumb") as HTMLDivElement;
const markdownEl = document.getElementById("markdown") as HTMLDivElement;
const emptyState = document.getElementById("empty-state") as HTMLDivElement;
const contentEl = document.getElementById("content") as HTMLDivElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const openFileBtn = document.getElementById(
  "open-file-btn"
) as HTMLButtonElement;
const examplesBtn = document.getElementById(
  "examples-btn"
) as HTMLButtonElement;
const welcomeRecentsWrap = document.getElementById(
  "welcome-recents"
) as HTMLDivElement;
const welcomeRecentsList = document.getElementById(
  "welcome-recents-list"
) as HTMLUListElement;
const welcomeRecentsClear = document.getElementById(
  "welcome-recents-clear"
) as HTMLButtonElement;
const outlineEl = document.getElementById("outline") as HTMLDivElement;
const outlineNav = document.getElementById("outline-nav") as HTMLElement;
const titlebarFilename = document.getElementById(
  "titlebar-filename"
) as HTMLSpanElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchCounter = document.getElementById(
  "search-counter"
) as HTMLSpanElement;
const searchPrev = document.getElementById("search-prev") as HTMLButtonElement;
const searchNext = document.getElementById("search-next") as HTMLButtonElement;
const searchOptionsBtn = document.getElementById(
  "search-options-btn"
) as HTMLButtonElement;
const searchOptionsMenu = document.getElementById(
  "search-options-menu"
) as HTMLDivElement;
const searchOptCase = document.getElementById(
  "search-opt-case"
) as HTMLInputElement;
const searchOptDiacritics = document.getElementById(
  "search-opt-diacritics"
) as HTMLInputElement;
const searchOptWholeWord = document.getElementById(
  "search-opt-wholeword"
) as HTMLInputElement;

let rootPath: string | null = null;
let rootName = "";
let currentPath: string[] = [];
let activeFile: string | null = null;
let scrollObserver: IntersectionObserver | null = null;

const sidebarTree = new SidebarTree(fileList, {
  onOpenFile: (absPath, opts) => {
    if (opts.newTab) {
      void tabManager.openInNewTab(absPath);
    } else {
      void tabManager.openInActiveTab(absPath);
    }
  },
  onReveal: (absPath) => revealInFinder(absPath),
  onRevealDir: (absPath) => revealInFinder(absPath),
});

const tabBar = document.getElementById("tab-bar") as HTMLDivElement;
const tabManager = new TabManager(tabBar, {
  onActivate: async (filePath, scrollY) => {
    // The tab system stores absolute paths. Route through the same
    // helper used by the sidebar so root-switching is consistent.
    await openFileFromAbsolutePath(filePath);
    // Restore scroll once the DOM is in place. requestAnimationFrame is
    // a single tick after parseMarkdown + mermaid → adequate for most
    // pages without a heavy heuristic.
    requestAnimationFrame(() => {
      contentEl.scrollTop = scrollY;
    });
  },
  onChange: () => {
    schedulePersistSession();
  },
  onEmpty: () => {
    // Last tab closed — clear the doc area but keep the folder open
    // so the user can still browse the sidebar.
    activeFile = null;
    markdownEl.innerHTML = "";
    markdownEl.style.display = "none";
    emptyState.style.display = "block";
    contentEl.classList.add("empty");
    titlebarFilename.textContent = "";
    outlineNav.innerHTML = "";
    outlineEl.style.display = "none";
    setSearchEnabled(false);
    sidebarTree.setActive(null);
    void pushRecentsToNativeMenu();
    schedulePersistSession();
  },
});

let sessionPersistTimer: number | null = null;
function schedulePersistSession(): void {
  if (sessionPersistTimer !== null) {
    window.clearTimeout(sessionPersistTimer);
  }
  sessionPersistTimer = window.setTimeout(() => {
    sessionPersistTimer = null;
    void persistSessionNow();
  }, 500);
}

async function persistSessionNow(): Promise<void> {
  const store = await load(STORE_FILE);
  const current = await loadSession(store);
  const state = tabManager.getState();
  if (state.activeId) {
    tabManager.captureScrollOfActive(contentEl.scrollTop);
  }
  const refreshed = tabManager.getState();
  const tabs = refreshed.tabs.map((t) => ({
    filePath: t.filePath,
    scrollY: t.scrollY,
  }));
  const activeIdx = refreshed.activeId
    ? refreshed.tabs.findIndex((t) => t.id === refreshed.activeId)
    : -1;
  await saveSession(store, {
    folder: current.folder,
    tabs,
    activeTabIndex: activeIdx,
  });
}

// Monotonic counter so concurrent scans (folder A → folder B before A's
// async scan finished) can't have the stale result clobber the fresh one.
// A scan whose generation doesn't match the latest issued is dropped.
let sidebarScanGeneration = 0;

async function refreshSidebarTree(autoExpandRoot = true): Promise<void> {
  if (!rootPath) {
    sidebarTree.clear();
    return;
  }
  const myGen = ++sidebarScanGeneration;
  const myRoot = rootPath;
  try {
    const result = await invoke<ScanResult>("scan_markdown_tree", {
      root: myRoot,
    });
    // Bail if either the user switched folders or kicked off another
    // scan while ours was in flight. Without this, A → B → setTree(A)
    // would show the wrong tree.
    if (myGen !== sidebarScanGeneration || myRoot !== rootPath) {
      return;
    }
    sidebarTree.setTree(result, autoExpandRoot);
    sidebarTree.setActive(absoluteActiveFile());
  } catch (e) {
    console.warn("scan_markdown_tree failed:", e);
  }
}

function absoluteActiveFile(): string | null {
  if (!rootPath || !activeFile) return null;
  return `${rootPath}/${activeFile}`;
}

// Used by TabManager.onActivate (and the sidebar click path that goes
// through it). Loads the file by relative path under the current root,
// switching roots if the file lives elsewhere.
async function openFileFromAbsolutePath(absPath: string): Promise<void> {
  if (!rootPath || !absPath.startsWith(rootPath + "/")) {
    const lastSep = absPath.lastIndexOf("/");
    const parentDir = absPath.substring(0, lastSep);
    const fileName = absPath.substring(lastSep + 1);
    await setRootPath(parentDir, fileName);
    await pushToRecents({
      kind: "file",
      path: absPath,
      displayName: fileName,
    });
    return;
  }
  const relative = absPath.slice(rootPath.length + 1);
  await loadFile(relative);
}

const STORE_FILE = "settings.json";

// --- Store persistence ---
//
// Folder persistence lives under the session blob (see src/session.ts).
// We still read the legacy `lastFolder` key on first load so users
// upgrading from pre-session builds don't lose their working directory.

async function saveRootPath(path: string): Promise<void> {
  const store = await load(STORE_FILE);
  const current = await loadSession(store);
  await saveSession(store, { ...current, folder: path });
}

async function loadRootPath(): Promise<string | null> {
  const store = await load(STORE_FILE);
  const session = await loadSession(store);
  return session.folder;
}

// --- Init ---

openBtn.addEventListener("click", openFolder);
openFileBtn.addEventListener("click", openFile);
examplesBtn.addEventListener("click", openExamples);
welcomeRecentsClear.addEventListener("click", clearRecentsFromUI);

async function openExamples(): Promise<void> {
  const examplesPath = await resolveResource("examples");
  await setRootPath(examplesPath);
}

type PendingOpen =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string };

function basename(p: string): string {
  const lastSep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return lastSep >= 0 ? p.slice(lastSep + 1) : p;
}

// Top-level "open this file" entry — used by ⌘O, recents, DnD, the
// cold-start pending-open buffer, and the open-file Tauri event. Always
// routes through the tab manager: a new tab if no folder was open or
// the file is outside the current root; otherwise opens-in-place.
async function openFileFromPath(filePath: string): Promise<void> {
  const lastSep = filePath.lastIndexOf("/");
  const fileName = filePath.substring(lastSep + 1);
  await pushToRecents({ kind: "file", path: filePath, displayName: fileName });
  // openInNewTab is the right primitive here: it dedupes against existing
  // tabs (re-clicking an already-open file just activates it) and creates
  // a fresh tab otherwise. The host's onActivate handles root-switching.
  await tabManager.openInNewTab(filePath);
}

async function openFile(): Promise<void> {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdx"] },
    ],
  });
  if (typeof selected === "string") {
    await openFileFromPath(selected);
  }
}

// --- Recents ---
//
// In-memory mirror of the persisted list. We keep it here so the welcome
// screen can re-render synchronously after every push/clear, and so the
// native menu rebuild has a single source of truth.
let recentsCache: RecentEntry[] = [];
let recentsMissing: Set<string> = new Set();

function recentKey(r: { kind: string; path: string }): string {
  return `${r.kind}:${r.path}`;
}

async function pushToRecents(
  entry: Omit<RecentEntry, "lastOpenedAt"> & { lastOpenedAt?: number },
): Promise<void> {
  const full: RecentEntry = {
    ...entry,
    lastOpenedAt: entry.lastOpenedAt ?? Date.now(),
  };
  recentsCache = pushRecent(recentsCache, full);
  // A freshly opened item exists by definition — clear any stale "missing".
  recentsMissing.delete(recentKey(full));
  await persistAndRefreshRecents();
}

async function persistAndRefreshRecents(): Promise<void> {
  const store = await load(STORE_FILE);
  await saveRecents(store, recentsCache);
  renderWelcomeRecents();
  await pushRecentsToNativeMenu();
}

async function pushRecentsToNativeMenu(): Promise<void> {
  const items = recentsCache.map((r) => ({
    kind: r.kind,
    path: r.path,
    label: r.displayName,
    enabled: !recentsMissing.has(recentKey(r)),
  }));
  try {
    await invoke("update_menu_state", {
      items,
      folderOpen: rootPath !== null,
      fileOpen: activeFile !== null,
    });
  } catch (e) {
    console.warn("Failed to update menu state:", e);
  }
}

function renderWelcomeRecents(): void {
  const entries: RecentDisplayEntry[] = recentsCache.map((r) => ({
    ...r,
    missing: recentsMissing.has(recentKey(r)),
  }));
  updateWelcomeVisibility(welcomeRecentsWrap, entries.length > 0);
  renderRecentsList(welcomeRecentsList, entries, {
    onOpenRecent: (entry) => openRecentEntry(entry),
    onReveal: (entry) => revealInFinder(entry.path),
    onRemove: (entry) => removeRecent(entry),
    onClear: () => clearRecentsFromUI(),
  });
}

async function openRecentEntry(entry: RecentEntry): Promise<void> {
  if (recentsMissing.has(recentKey(entry))) {
    showToast(t("toast.recent.missing"), "error");
    await removeRecent(entry);
    return;
  }
  if (entry.kind === "file") {
    await openFileFromPath(entry.path);
  } else {
    await setRootPath(entry.path);
    await pushToRecents({
      kind: "folder",
      path: entry.path,
      displayName: entry.displayName,
    });
  }
}

async function removeRecent(entry: RecentEntry): Promise<void> {
  const key = recentKey(entry);
  recentsCache = recentsCache.filter((r) => recentKey(r) !== key);
  recentsMissing.delete(key);
  await persistAndRefreshRecents();
}

async function clearRecentsFromUI(): Promise<void> {
  recentsCache = [];
  recentsMissing.clear();
  await persistAndRefreshRecents();
}

async function revealInFinder(path: string): Promise<void> {
  try {
    await invoke("reveal_in_finder", { path });
  } catch (e) {
    console.warn("reveal_in_finder failed:", e);
  }
}

async function validateRecentsAndRefresh(): Promise<void> {
  if (recentsCache.length === 0) {
    renderWelcomeRecents();
    return;
  }
  try {
    const results = await invoke<Array<{ exists: boolean; kind: string }>>(
      "validate_paths",
      { paths: recentsCache.map((r) => r.path) },
    );
    recentsMissing = new Set();
    recentsCache.forEach((r, i) => {
      if (!results[i]?.exists) {
        recentsMissing.add(recentKey(r));
      }
    });
  } catch (e) {
    console.warn("validate_paths failed:", e);
  }
  renderWelcomeRecents();
  await pushRecentsToNativeMenu();
}

// --- Search ---

let searchController: SearchController | null = null;

function setSearchEnabled(enabled: boolean): void {
  searchInput.disabled = !enabled;
  searchPrev.disabled = !enabled;
  searchNext.disabled = !enabled;
  if (!enabled && searchController) {
    searchController.clear();
  }
}

function handleSearchInputKey(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      searchController?.prev();
    } else {
      searchController?.next();
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (searchInput.value) {
      searchController?.clear();
    } else {
      searchInput.blur();
    }
  }
}

function handleGlobalSearchShortcut(e: KeyboardEvent): void {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) {
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "f" && !searchInput.disabled) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (key === "g" && !searchInput.disabled && searchInput.value) {
    e.preventDefault();
    if (e.shiftKey) {
      searchController?.prev();
    } else {
      searchController?.next();
    }
  }
}

// ⌘T / ⌘W / ⌘1..⌘9 / ⌘⇧[ / ⌘⇧]. Registered at init time. Bypassed
// while typing in form fields so search input shortcuts still work.
function handleTabShortcut(e: KeyboardEvent): void {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const target = e.target as HTMLElement | null;
  const inField =
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable);
  // Tab cycling is always allowed; the others would steal typing keys.
  const key = e.key.toLowerCase();

  if (key === "t" && !inField) {
    e.preventDefault();
    void openFile();
    return;
  }
  if (key === "w" && !e.shiftKey && !inField) {
    // ⌘W closes the active tab; falls through to native close-window
    // only when no tab is open.
    if (tabManager.getState().tabs.length > 0) {
      e.preventDefault();
      void tabManager.closeActive();
    }
    return;
  }
  if (e.shiftKey && (key === "]" || key === "}")) {
    e.preventDefault();
    tabManager.cycle(1);
    return;
  }
  if (e.shiftKey && (key === "[" || key === "{")) {
    e.preventDefault();
    tabManager.cycle(-1);
    return;
  }
  if (!inField && /^[1-9]$/.test(key)) {
    e.preventDefault();
    tabManager.jumpTo(Number(key));
  }
}

function applySearchOptions(): void {
  searchController?.setOptions({
    caseSensitive: searchOptCase.checked,
    ignoreDiacritics: searchOptDiacritics.checked,
    wholeWord: searchOptWholeWord.checked,
  });
}

function initSearch(): void {
  searchController = createSearchController(markdownEl, {
    input: searchInput,
    counter: searchCounter,
  });

  searchInput.addEventListener("keydown", handleSearchInputKey);
  searchPrev.addEventListener("click", () => searchController?.prev());
  searchNext.addEventListener("click", () => searchController?.next());

  function setOptionsMenuOpen(open: boolean): void {
    searchOptionsMenu.classList.toggle("visible", open);
    searchOptionsBtn.setAttribute("aria-expanded", String(open));
  }

  searchOptionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOptionsMenuOpen(!searchOptionsMenu.classList.contains("visible"));
  });

  document.addEventListener("click", (e) => {
    if (
      !searchOptionsMenu.contains(e.target as Node) &&
      e.target !== searchOptionsBtn
    ) {
      setOptionsMenuOpen(false);
    }
  });

  searchOptionsMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setOptionsMenuOpen(false);
      searchOptionsBtn.focus();
    }
  });

  searchOptCase.addEventListener("change", applySearchOptions);
  searchOptDiacritics.addEventListener("change", applySearchOptions);
  searchOptWholeWord.addEventListener("change", applySearchOptions);

  document.addEventListener("keydown", handleGlobalSearchShortcut);
  document.addEventListener("keydown", handleTabShortcut);

  // Persist the scroll position into the active tab so cycling back
  // returns to the same reading position. Throttled implicitly via
  // requestAnimationFrame.
  let scrollRafScheduled = false;
  contentEl.addEventListener("scroll", () => {
    if (scrollRafScheduled) return;
    scrollRafScheduled = true;
    requestAnimationFrame(() => {
      scrollRafScheduled = false;
      tabManager.captureScrollOfActive(contentEl.scrollTop);
    });
  });
}

// --- Preferences modal ---

const prefsBackdrop = document.getElementById(
  "prefs-backdrop"
) as HTMLDivElement;
const prefsClose = document.getElementById("prefs-close") as HTMLButtonElement;
const prefsDone = document.getElementById("prefs-done") as HTMLButtonElement;
const prefsFontSize = document.getElementById(
  "prefs-fontsize"
) as HTMLSelectElement;
const prefsOutline = document.getElementById("prefs-outline") as HTMLDivElement;
const prefsTabs = document.querySelectorAll<HTMLButtonElement>(".prefs-tab");
const prefsTabPanels =
  document.querySelectorAll<HTMLDivElement>(".prefs-tab-panel");
const prefsThemeGrid = document.getElementById(
  "prefs-theme-grid"
) as HTMLDivElement;
const prefsFollowSystem = document.getElementById(
  "prefs-follow-system"
) as HTMLInputElement;
const prefsLanguage = document.getElementById(
  "prefs-language"
) as HTMLSelectElement;
const prefsImportTheme = document.getElementById(
  "prefs-import-theme"
) as HTMLButtonElement;
const prefsImportError = document.getElementById(
  "prefs-import-error"
) as HTMLSpanElement;
const prefsNewTheme = document.getElementById(
  "prefs-new-theme"
) as HTMLButtonElement;
const prefsRevealThemes = document.getElementById(
  "prefs-reveal-themes"
) as HTMLButtonElement;
const prefsPanelAppearance = document.getElementById(
  "prefs-panel-appearance"
) as HTMLDivElement;
const prefsEditor = document.getElementById("prefs-editor") as HTMLDivElement;
const prefsEditorName = document.getElementById(
  "prefs-editor-name"
) as HTMLInputElement;
const prefsEditorId = document.getElementById(
  "prefs-editor-id"
) as HTMLInputElement;
const prefsEditorIsDark = document.getElementById(
  "prefs-editor-isdark"
) as HTMLSelectElement;
const prefsEditorPair = document.getElementById(
  "prefs-editor-pair"
) as HTMLSelectElement;
const prefsEditorVars = document.getElementById(
  "prefs-editor-vars"
) as HTMLDivElement;
const prefsEditorBack = document.getElementById(
  "prefs-editor-back"
) as HTMLButtonElement;
const prefsEditorCancel = document.getElementById(
  "prefs-editor-cancel"
) as HTMLButtonElement;
const prefsEditorSave = document.getElementById(
  "prefs-editor-save"
) as HTMLButtonElement;
const prefsAdvancedToggle = document.getElementById(
  "prefs-advanced-toggle"
) as HTMLButtonElement;
const prefsAdvancedReset = document.getElementById(
  "prefs-advanced-reset"
) as HTMLButtonElement;
const prefsAdvanced = document.getElementById(
  "prefs-advanced"
) as HTMLDivElement;
const prefsAdvancedCaret = document.getElementById(
  "prefs-advanced-caret"
) as HTMLSpanElement;
const prefsBodyFont = document.getElementById(
  "prefs-body-font"
) as HTMLSelectElement;
const prefsCodeFont = document.getElementById(
  "prefs-code-font"
) as HTMLSelectElement;
const prefsFontWeight = document.getElementById(
  "prefs-font-weight"
) as HTMLSelectElement;
const prefsCustomSize = document.getElementById(
  "prefs-custom-size"
) as HTMLInputElement;

let fontsLoaded = false;

async function populateFontDropdowns(): Promise<void> {
  if (fontsLoaded) return;
  fontsLoaded = true;
  try {
    const families = await invoke<string[]>("list_system_fonts");
    for (const select of [prefsBodyFont, prefsCodeFont]) {
      // Preserve the "System default" placeholder option (value="").
      const placeholder = select.querySelector("option");
      select.innerHTML = "";
      if (placeholder) select.appendChild(placeholder);
      for (const name of families) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
    }
    syncPrefsUI();
  } catch (e) {
    console.warn("Failed to load system fonts:", e);
  }
}

function syncPrefsUI(): void {
  prefsFollowSystem.checked = followSystem;
  prefsLanguage.value = getLocale();
  refreshThemeGridSelection();
  prefsFontSize.value =
    (document.documentElement.dataset.fontsize as FontSize) ?? "medium";
  setSegmentActive(
    prefsOutline,
    (document.documentElement.dataset.outline as OutlinePref) ?? "auto"
  );
  prefsBodyFont.value = currentBodyFont ?? "";
  prefsCodeFont.value = currentCodeFont ?? "";
  prefsFontWeight.value = currentFontWeight ?? "";
  prefsCustomSize.value =
    currentCustomFontSize !== null ? String(currentCustomFontSize) : "";
}

function refreshThemeGridSelection(): void {
  if (!prefsThemeGrid) return;
  const activeId = currentThemeId;
  for (const tile of prefsThemeGrid.querySelectorAll<HTMLButtonElement>(
    ".prefs-theme-tile"
  )) {
    tile.classList.toggle("active", tile.dataset.themeId === activeId);
  }
  prefsThemeGrid.classList.toggle("disabled", followSystem);
}

function buildThemeGrid(): void {
  prefsThemeGrid.innerHTML = "";
  const order: ThemeId[] = [
    ...BUILTIN_THEME_ORDER,
    ...customThemes
      .map((c) => c.id)
      .filter((id) => !(id in BUILTIN_THEMES)),
  ];
  for (const id of order) {
    const theme = themeCatalog[id];
    if (!theme) continue;
    prefsThemeGrid.appendChild(buildThemeTile(theme));
  }
}

function buildThemeTile(theme: Theme): HTMLButtonElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "prefs-theme-tile";
  tile.dataset.themeId = theme.id;

  const preview = document.createElement("div");
  preview.className = "prefs-theme-preview";
  preview.style.background = theme.vars["--bg"];

  const text = document.createElement("span");
  text.className = "prefs-theme-preview-text";
  text.style.color = theme.vars["--text"];
  text.textContent = "Aa";

  const accent = document.createElement("span");
  accent.className = "prefs-theme-preview-accent";
  accent.style.background = theme.vars["--accent"];

  const code = document.createElement("span");
  code.className = "prefs-theme-preview-code";
  code.style.background = theme.vars["--code-bg"];
  code.style.color = theme.vars["--text-muted"];
  code.textContent = "{ }";

  preview.appendChild(text);
  preview.appendChild(accent);
  preview.appendChild(code);

  const nameRow = document.createElement("div");
  nameRow.className = "prefs-theme-name";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = theme.name;
  const check = document.createElement("span");
  check.className = "prefs-theme-check";
  check.textContent = "✓";
  nameRow.appendChild(nameSpan);
  nameRow.appendChild(check);

  tile.appendChild(preview);
  tile.appendChild(nameRow);

  const actions = document.createElement("span");
  actions.className = "prefs-theme-actions";

  if (theme.custom) {
    tile.classList.add("custom");

    const edit = document.createElement("span");
    edit.className = "prefs-theme-action edit";
    edit.textContent = "✎";
    edit.title = t("prefs.appearance.edit");
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(theme, { editing: true });
    });
    actions.appendChild(edit);
  }

  const dup = document.createElement("span");
  dup.className = "prefs-theme-action duplicate";
  dup.textContent = "⧉";
  dup.title = t("prefs.appearance.duplicate");
  dup.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditor({ ...theme, custom: true }, { duplicateFrom: theme.id });
  });
  actions.appendChild(dup);

  if (theme.custom) {
    const del = document.createElement("span");
    del.className = "prefs-theme-action delete";
    del.textContent = "×";
    del.title = t("prefs.appearance.delete");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: t("prefs.appearance.delete.confirm.title"),
        message: t("prefs.appearance.delete.confirm"),
        okLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        destructive: true,
      });
      if (!ok) return;
      await deleteCustomTheme(theme.id);
    });
    actions.appendChild(del);
  }

  tile.appendChild(actions);

  tile.addEventListener("click", async () => {
    currentThemeId = theme.id;
    applyActiveTheme();
    refreshThemeGridSelection();
    await savePref(THEME_KEY, theme.id);
  });

  return tile;
}

async function deleteCustomTheme(id: ThemeId): Promise<void> {
  customThemes = customThemes.filter((c) => c.id !== id);
  themeCatalog = buildThemeCatalog(customThemes);
  if (!(currentThemeId in themeCatalog)) {
    currentThemeId = "light";
    await savePref(THEME_KEY, currentThemeId);
  }
  applyActiveTheme();
  buildThemeGrid();
  refreshThemeGridSelection();
  await savePref(CUSTOM_THEMES_KEY, customThemes);
  try {
    await invoke("delete_disk_theme", { id });
  } catch (e) {
    console.warn("Failed to delete disk theme file:", e);
  }
}

async function persistCustomTheme(theme: Theme): Promise<void> {
  customThemes = [
    ...customThemes.filter((c) => c.id !== theme.id),
    { ...theme, custom: true },
  ];
  themeCatalog = buildThemeCatalog(customThemes);
  await savePref(CUSTOM_THEMES_KEY, customThemes);
  try {
    const json = JSON.stringify(
      {
        id: theme.id,
        name: theme.name,
        isDark: theme.isDark,
        pair: theme.pair,
        vars: theme.vars,
      },
      null,
      2
    );
    await invoke("save_disk_theme", { id: theme.id, json });
  } catch (e) {
    console.warn("Failed to write theme file to disk:", e);
  }
}

async function importCustomTheme(jsonText: string): Promise<boolean> {
  const theme = parseTheme(jsonText);
  if (!theme) return false;
  await persistCustomTheme(theme);
  currentThemeId = theme.id;
  applyActiveTheme();
  buildThemeGrid();
  refreshThemeGridSelection();
  await savePref(THEME_KEY, theme.id);
  return true;
}

// --- Visual theme editor ---

interface EditorContext {
  /** When set, the editor is editing an existing custom theme (same id). */
  editing?: boolean;
  /** When set, the editor seeded its values from this theme id (used to generate a unique id). */
  duplicateFrom?: string;
}

let editorContext: EditorContext = {};
let editorPreviewSnapshot: Record<string, string> | null = null;

function snapshotCurrentVars(): Record<string, string> {
  const out: Record<string, string> = {};
  const style = document.documentElement.style;
  for (const k of REQUIRED_VAR_KEYS) {
    out[k] = style.getPropertyValue(k);
  }
  return out;
}

function restorePreviewSnapshot(): void {
  if (!editorPreviewSnapshot) return;
  restoreSnapshotOnto(
    document.documentElement,
    editorPreviewSnapshot,
    REQUIRED_VAR_KEYS
  );
  editorPreviewSnapshot = null;
}

function existingIdSet(): Set<string> {
  return new Set(Object.keys(themeCatalog));
}

/**
 * Recompute the readonly id field from the current name.
 *
 * When editing an existing custom theme in place, the theme's original id is
 * excluded from the "taken" set so the field stays stable as long as the name
 * resolves to the same slug.
 */
function recomputeEditorId(): void {
  prefsEditorId.value = computeAutoId(
    prefsEditorName.value,
    existingIdSet(),
    prefsEditorId.dataset.originalId
  );
}

function openEditor(seed: Theme, ctx: EditorContext = {}): void {
  editorContext = ctx;
  editorPreviewSnapshot = snapshotCurrentVars();

  // Decide the initial name; the id is then computed from it.
  let name = seed.name;
  if (ctx.duplicateFrom) {
    name = `${seed.name}${t("editor.duplicate.suffix")}`;
  } else if (!ctx.editing) {
    name = t("editor.default.name");
  }

  prefsEditorName.value = name;
  if (ctx.editing) {
    prefsEditorId.dataset.originalId = seed.id;
  } else {
    delete prefsEditorId.dataset.originalId;
  }
  recomputeEditorId();
  prefsEditorIsDark.value = seed.isDark ? "true" : "false";

  // Populate pair dropdown with all current ids.
  prefsEditorPair.innerHTML = "";
  for (const tid of Object.keys(themeCatalog)) {
    const opt = document.createElement("option");
    opt.value = tid;
    opt.textContent = themeCatalog[tid].name;
    prefsEditorPair.appendChild(opt);
  }
  prefsEditorPair.value = themeCatalog[seed.pair] ? seed.pair : "light";

  renderEditorVars(seed.vars);
  prefsPanelAppearance.classList.add("prefs-editor-mode");
  // Live preview: apply seed to <html> immediately.
  applyEditorPreview();
  // Editor is a deep-dive into a form; jump straight to the Name field so
  // the user can start typing without an extra Tab.
  prefsFocusTrap?.focusElement(prefsEditorName);
}

function closeEditor(restore: boolean): void {
  prefsPanelAppearance.classList.remove("prefs-editor-mode");
  if (restore) restorePreviewSnapshot();
  editorPreviewSnapshot = null;
  editorContext = {};
  // Back to the Appearance tab button so keyboard users return to the same
  // anchor they had when they opened the editor.
  prefsFocusTrap?.focusElement(getActiveTabButton());
}

function renderEditorVars(vars: Record<string, string>): void {
  prefsEditorVars.innerHTML = "";
  for (const meta of VAR_META) {
    const row = document.createElement("div");
    row.className = "prefs-editor-var";
    row.dataset.varKey = meta.key;

    const labelWrap = document.createElement("div");
    labelWrap.className = "prefs-editor-var-label";
    const labelName = document.createElement("span");
    labelName.className = "prefs-editor-var-name";
    labelName.textContent = t(meta.labelKey);
    const labelKey = document.createElement("span");
    labelKey.className = "prefs-editor-var-key";
    labelKey.textContent = meta.key;
    labelWrap.appendChild(labelName);
    labelWrap.appendChild(labelKey);

    const initial = vars[meta.key] ?? "#000000";
    const initialHex = toHexForPicker(initial) ?? "#000000";

    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = initialHex;

    const text = document.createElement("input");
    text.type = "text";
    text.value = initial;
    text.spellcheck = false;

    picker.addEventListener("input", () => {
      text.value = picker.value;
      text.classList.remove("invalid");
      applyEditorPreview();
    });
    text.addEventListener("input", () => {
      const hex = toHexForPicker(text.value);
      if (hex) {
        picker.value = hex;
        text.classList.remove("invalid");
        applyEditorPreview();
      } else {
        text.classList.add("invalid");
      }
    });

    row.appendChild(labelWrap);
    row.appendChild(picker);
    row.appendChild(text);
    prefsEditorVars.appendChild(row);
  }
}

function readEditorVars(): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const row of prefsEditorVars.querySelectorAll<HTMLDivElement>(
    ".prefs-editor-var"
  )) {
    const key = row.dataset.varKey;
    if (!key) continue;
    const text = row.querySelector<HTMLInputElement>('input[type="text"]');
    if (!text) continue;
    const value = text.value.trim();
    if (!value || toHexForPicker(value) === null) {
      text.classList.add("invalid");
      return null;
    }
    out[key] = value;
  }
  return out;
}

function applyEditorPreview(): void {
  const vars = readEditorVarsRaw();
  const style = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) {
    if (v) style.setProperty(k, v);
  }
}

function readEditorVarsRaw(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of prefsEditorVars.querySelectorAll<HTMLDivElement>(
    ".prefs-editor-var"
  )) {
    const key = row.dataset.varKey;
    if (!key) continue;
    const text = row.querySelector<HTMLInputElement>('input[type="text"]');
    if (text) out[key] = text.value;
  }
  return out;
}

async function saveEditorTheme(): Promise<void> {
  const rawName = prefsEditorName.value.trim();
  if (!rawName) {
    prefsEditorName.focus();
    return;
  }
  const vars = readEditorVars();
  if (!vars) return; // an input was invalid; the field is already highlighted

  // recomputeEditorId() keeps the id unique on every name keystroke, but we
  // re-run the check here as a safety net (e.g. if the catalog changed between
  // typing and clicking Save, or the readonly field was somehow blanked).
  const id = computeAutoId(
    rawName,
    existingIdSet(),
    prefsEditorId.dataset.originalId
  );

  const theme: Theme = {
    id,
    name: rawName,
    isDark: prefsEditorIsDark.value === "true",
    pair: prefsEditorPair.value || "light",
    vars: vars as Theme["vars"],
    custom: true,
  };

  // If editing and the id changed (rare), drop the old custom entry.
  if (editorContext.editing) {
    const originalId = prefsEditorId.dataset.originalId;
    if (originalId && originalId !== id) {
      customThemes = customThemes.filter((c) => c.id !== originalId);
      try {
        await invoke("delete_disk_theme", { id: originalId });
      } catch {
        // ignore
      }
    }
  }

  await persistCustomTheme(theme);
  currentThemeId = theme.id;
  await savePref(THEME_KEY, theme.id);
  buildThemeGrid();
  applyActiveTheme();
  refreshThemeGridSelection();
  editorPreviewSnapshot = null; // committed; no rollback
  closeEditor(false);
}

let prefsFocusTrap: FocusTrap | null = null;

function getActiveTabButton(): HTMLButtonElement | null {
  for (const t of prefsTabs) {
    if (t.classList.contains("active")) return t;
  }
  return null;
}

function setActiveTab(tab: string): void {
  for (const t of prefsTabs) {
    const isActive = t.dataset.tab === tab;
    t.classList.toggle("active", isActive);
    t.setAttribute("aria-selected", String(isActive));
    t.setAttribute("tabindex", isActive ? "0" : "-1");
  }
  for (const p of prefsTabPanels) {
    p.classList.toggle("active", p.id === `prefs-panel-${tab}`);
  }
  // On tab change focus the newly active tab button — this matches the ARIA
  // tabs pattern (the selected tab is the natural keyboard anchor) and keeps
  // the trap boundaries accurate after the panel content swap.
  prefsFocusTrap?.focusElement(getActiveTabButton());
}

function openPrefs(): void {
  syncPrefsUI();
  prefsBackdrop.style.display = "flex";
  requestAnimationFrame(() => prefsBackdrop.classList.add("visible"));
  void populateFontDropdowns();
  prefsFocusTrap?.release();
  // Open with focus on the active tab rather than the close (×) button, which
  // is the default first-focusable. Tabs are a more meaningful entry point.
  prefsFocusTrap = trapFocus(prefsBackdrop, {
    initialFocus: () => getActiveTabButton(),
  });
}

function setAdvancedOpen(open: boolean): void {
  prefsAdvanced.classList.toggle("visible", open);
  prefsAdvancedToggle.setAttribute("aria-expanded", String(open));
  prefsAdvancedCaret.textContent = open ? "▾" : "▸";
}

function closePrefs(): void {
  prefsBackdrop.classList.remove("visible");
  setTimeout(() => {
    prefsBackdrop.style.display = "none";
    // Reset transient UI state so the next open lands on a clean default:
    // - close the theme editor if it was open (no preview rollback needed —
    //   user explicitly closed the modal, treat it as a Cancel),
    // - collapse the advanced typography section,
    // - jump to the General tab,
    // - reset the body scroll to the top.
    if (prefsPanelAppearance.classList.contains("prefs-editor-mode")) {
      closeEditor(true);
    }
    setAdvancedOpen(false);
    setActiveTab("general");
    const body = prefsBackdrop.querySelector<HTMLDivElement>(".prefs-body");
    if (body) body.scrollTop = 0;
  }, 180);
  prefsFocusTrap?.release();
  prefsFocusTrap = null;
}

async function savePref<T>(key: string, value: T): Promise<void> {
  const store = await load(STORE_FILE);
  await store.set(key, value);
  await store.save();
}

function initPreferences(): void {
  prefsClose.addEventListener("click", closePrefs);
  prefsDone.addEventListener("click", closePrefs);
  prefsBackdrop.addEventListener("click", (e) => {
    if (e.target === prefsBackdrop) closePrefs();
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      prefsBackdrop.classList.contains("visible")
    ) {
      e.preventDefault();
      closePrefs();
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === ",") {
      e.preventDefault();
      if (prefsBackdrop.classList.contains("visible")) {
        closePrefs();
      } else {
        openPrefs();
      }
    }
  });

  for (const tab of prefsTabs) {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      if (name) setActiveTab(name);
    });
    // ARIA tabs pattern: left/right cycle through the tab list, Home/End jump
    // to first/last. The handler runs only when the focused element is one of
    // the tabs, so it doesn't interfere with text input elsewhere in the modal.
    tab.addEventListener("keydown", (e) => {
      const list = Array.from(prefsTabs);
      const idx = list.indexOf(tab);
      if (idx < 0) return;
      let next = -1;
      if (e.key === "ArrowRight") next = (idx + 1) % list.length;
      else if (e.key === "ArrowLeft")
        next = (idx - 1 + list.length) % list.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      else return;
      e.preventDefault();
      const target = list[next];
      const name = target.dataset.tab;
      if (name) setActiveTab(name);
    });
  }

  buildThemeGrid();

  prefsFollowSystem.addEventListener("change", async () => {
    followSystem = prefsFollowSystem.checked;
    applyActiveTheme();
    refreshThemeGridSelection();
    await savePref(FOLLOW_SYSTEM_KEY, followSystem);
  });

  prefsLanguage.addEventListener("change", async () => {
    const value = prefsLanguage.value;
    if (!isLocale(value)) return;
    setLocale(value as Locale);
    document.documentElement.lang = value;
    applyTranslations(document);
    await savePref(LOCALE_KEY, value);
  });

  prefsImportTheme.addEventListener("click", async () => {
    prefsImportError.style.display = "none";
    const selected = await open({
      multiple: false,
      filters: [{ name: "Theme JSON", extensions: ["json"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      const text = await readTextFile(selected);
      const ok = await importCustomTheme(text);
      if (!ok) throw new Error("invalid");
    } catch {
      prefsImportError.textContent = t("prefs.appearance.import.error");
      prefsImportError.style.display = "inline";
    }
  });

  prefsNewTheme.addEventListener("click", () => {
    const seed = themeCatalog[currentThemeId] ?? BUILTIN_THEMES.light;
    openEditor(seed, {});
  });

  prefsRevealThemes.addEventListener("click", async () => {
    try {
      await invoke("reveal_themes_dir");
    } catch (e) {
      console.warn("Reveal failed:", e);
    }
  });

  prefsEditorBack.addEventListener("click", () => closeEditor(true));
  prefsEditorCancel.addEventListener("click", () => closeEditor(true));
  prefsEditorSave.addEventListener("click", saveEditorTheme);

  prefsEditorName.addEventListener("input", () => {
    recomputeEditorId();
  });

  prefsFontSize.addEventListener("change", async () => {
    const value = prefsFontSize.value as FontSize;
    applyFontSize(value);
    await savePref(FONTSIZE_KEY, value);
  });

  for (const btn of prefsOutline.querySelectorAll<HTMLButtonElement>(
    "button"
  )) {
    btn.addEventListener("click", async () => {
      const value = btn.dataset.value as OutlinePref;
      applyOutlinePref(value);
      setSegmentActive(prefsOutline, value);
      await savePref(OUTLINE_PREF_KEY, value);
    });
  }

  prefsAdvancedToggle.addEventListener("click", () => {
    const open = !prefsAdvanced.classList.contains("visible");
    setAdvancedOpen(open);
  });

  prefsBodyFont.addEventListener("change", async () => {
    const v = prefsBodyFont.value || null;
    currentBodyFont = v;
    applyBodyFontToDOM(document.documentElement, v);
    await savePref(BODY_FONT_KEY, v);
  });

  prefsCodeFont.addEventListener("change", async () => {
    const v = prefsCodeFont.value || null;
    currentCodeFont = v;
    applyCodeFontToDOM(document.documentElement, v);
    await savePref(CODE_FONT_KEY, v);
  });

  prefsFontWeight.addEventListener("change", async () => {
    const raw = prefsFontWeight.value;
    const v = raw === "" ? null : (raw as FontWeight);
    currentFontWeight = v;
    applyFontWeightToDOM(document.documentElement, v);
    await savePref(FONT_WEIGHT_KEY, v);
  });

  prefsCustomSize.addEventListener("change", async () => {
    const raw = prefsCustomSize.value.trim();
    let v: number | null = null;
    if (raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        v = Math.min(
          MAX_CUSTOM_FONT_SIZE,
          Math.max(MIN_CUSTOM_FONT_SIZE, Math.round(n))
        );
      }
    }
    currentCustomFontSize = v;
    prefsCustomSize.value = v !== null ? String(v) : "";
    applyCustomFontSizeToDOM(document.documentElement, v);
    await savePref(CUSTOM_FONT_SIZE_KEY, v);
  });

  prefsAdvancedReset.addEventListener("click", async () => {
    currentBodyFont = null;
    currentCodeFont = null;
    currentFontWeight = null;
    currentCustomFontSize = null;
    applyBodyFontToDOM(document.documentElement, null);
    applyCodeFontToDOM(document.documentElement, null);
    applyFontWeightToDOM(document.documentElement, null);
    applyCustomFontSizeToDOM(document.documentElement, null);
    await savePref(BODY_FONT_KEY, null);
    await savePref(CODE_FONT_KEY, null);
    await savePref(FONT_WEIGHT_KEY, null);
    await savePref(CUSTOM_FONT_SIZE_KEY, null);
    syncPrefsUI();
  });
}

async function initLocale(): Promise<void> {
  const store = await load(STORE_FILE);
  const saved = await store.get(LOCALE_KEY);
  const locale = resolveInitialLocale(saved, navigator.language);
  setLocale(locale);
  applyTranslations(document);
  document.documentElement.lang = locale;
}

async function init(): Promise<void> {
  await initLocale();
  await initTheme();
  initSearch();
  initPreferences();
  const appWindow = getCurrentWindow();

  // Load recents once at startup, validate existence (dim missing entries),
  // and prime both the welcome list and the native Open Recent submenu.
  const store = await load(STORE_FILE);
  recentsCache = await loadRecentsFromStore(store);
  await validateRecentsAndRefresh();

  // Runtime opens (hot-start file association, "Open With", CLI events)
  appWindow.listen<string>("open-folder", async (event) => {
    await setRootPath(event.payload);
    await pushToRecents({
      kind: "folder",
      path: event.payload,
      displayName: extractRootName(event.payload),
    });
  });
  appWindow.listen<string>("open-file", (event) => {
    openFileFromPath(event.payload);
  });
  appWindow.listen("menu-open-folder", () => {
    openFolder();
  });
  appWindow.listen("menu-open-file", () => {
    openFile();
  });
  appWindow.listen<{ kind: "file" | "folder"; path: string }>(
    "menu-open-recent",
    async (event) => {
      const { kind, path } = event.payload;
      const cached = recentsCache.find(
        (r) => r.kind === kind && r.path === path,
      );
      const entry: RecentEntry = cached ?? {
        kind,
        path,
        displayName: basename(path),
        lastOpenedAt: Date.now(),
      };
      await openRecentEntry(entry);
    },
  );
  appWindow.listen("menu-clear-recents", () => {
    clearRecentsFromUI();
  });
  appWindow.listen("menu-close-folder", () => {
    closeFolder();
  });
  appWindow.listen("menu-save", () => {
    runSave();
  });
  appWindow.listen<ExportFormat>("menu-export", (event) => {
    exportAs(event.payload);
  });
  appWindow.listen("menu-share", () => {
    runShare();
  });
  appWindow.listen("menu-print", () => {
    invoke("print_webview");
  });
  appWindow.listen("menu-open-preferences", () => {
    openPrefs();
  });

  // Live tree updates from the Rust watcher. Debounced beyond the 200ms
  // backend debounce so a slow filesystem (cloud, network) doesn't keep
  // re-scanning while events trickle in.
  let rescanTimer: number | null = null;
  appWindow.listen("fs-change", () => {
    if (rescanTimer !== null) window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      rescanTimer = null;
      // autoExpandRoot=false so the user's expansion state survives.
      void refreshSidebarTree(false);
    }, 150);
  });

  // Drag & drop: accept .md/.markdown/.mdx files and directories.
  appWindow.onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const paths = (event.payload as { type: "drop"; paths: string[] }).paths;
    for (const p of paths) {
      const lower = p.toLowerCase();
      const isMarkdown =
        lower.endsWith(".md") ||
        lower.endsWith(".markdown") ||
        lower.endsWith(".mdx");
      try {
        const [valid] = await invoke<
          Array<{ exists: boolean; kind: string }>
        >("validate_paths", { paths: [p] });
        if (!valid?.exists) {
          showToast(t("toast.dnd.rejected"), "error");
          continue;
        }
        if (valid.kind === "dir") {
          await setRootPath(p);
          await pushToRecents({
            kind: "folder",
            path: p,
            displayName: extractRootName(p),
          });
          return;
        }
        if (valid.kind === "file" && isMarkdown) {
          await openFileFromPath(p);
          return;
        }
        showToast(t("toast.dnd.rejected"), "error");
      } catch (e) {
        console.warn("DnD validation failed:", e);
      }
    }
  });

  // Cold-start: pull anything the backend buffered (CLI arg or RunEvent::Opened
  // that fired before our listener was registered). A pending open wins over
  // the saved folder so the user doesn't see a flash of the previous folder.
  const pending = await invoke<PendingOpen | null>("get_pending_open");
  if (pending?.kind === "file") {
    await openFileFromPath(pending.path);
    return;
  }
  if (pending?.kind === "folder") {
    await setRootPath(pending.path);
    return;
  }

  const savedSession = await loadSession(store);
  if (savedSession.folder) {
    await setRootPath(savedSession.folder);
  }
  // Restore tabs after the root is set so file paths resolve. Validate
  // each tab still exists on disk AND is a file (not a directory left
  // behind by a poisoned session.json). Silently drop everything else.
  if (savedSession.tabs.length > 0) {
    const paths = savedSession.tabs.map((t) => t.filePath);
    let validity: Array<{ exists: boolean; kind: string }> = [];
    try {
      validity = await invoke<Array<{ exists: boolean; kind: string }>>(
        "validate_paths",
        { paths },
      );
    } catch {
      validity = paths.map(() => ({ exists: false, kind: "missing" }));
    }
    const surviving = savedSession.tabs.filter(
      (_, i) => validity[i]?.exists && validity[i]?.kind === "file",
    );
    if (surviving.length > 0) {
      // IDs are prefixed with "restored-" to avoid colliding with the
      // module-level counter used by openInNewTab. Without this, the
      // first new tab opened after a restore would get id "tab-1" —
      // the same as the first restored tab — and clicking one would
      // mis-activate the other.
      //
      // Guard: this collision-avoidance assumes restore-with-tabs runs
      // at most once per process. A future refactor that calls it
      // twice would silently re-allocate "restored-1" and produce
      // duplicates. Trip an error if that ever happens so the bug
      // surfaces immediately.
      if (sessionRestored) {
        throw new Error(
          "session restore called twice — restored- IDs would collide",
        );
      }
      sessionRestored = true;
      const restoredTabs: Tab[] = surviving.map((t, i) => ({
        id: `restored-${i + 1}`,
        filePath: t.filePath,
        title: t.filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "tab",
        scrollY: t.scrollY,
      }));
      const activeIdx = Math.max(
        0,
        Math.min(savedSession.activeTabIndex, restoredTabs.length - 1),
      );
      await tabManager.restore(restoredTabs, restoredTabs[activeIdx].id);
      await tabManager.activate(restoredTabs[activeIdx].id);
    }
  }
}

let sessionRestored = false;

async function setRootPath(path: string, fileToOpen?: string): Promise<void> {
  rootPath = path;
  rootName = extractRootName(path);
  currentPath = [];
  activeFile = null;
  await saveRootPath(path);
  // Tell the backend so reveal_in_finder can authorize paths under this
  // root. Best-effort: a failure here only narrows allowed scope.
  invoke("register_current_root", { path }).catch((e) => {
    console.warn("register_current_root failed:", e);
  });
  await renderSidebar();
  if (fileToOpen) {
    // fileToOpen is relative to the new root; load directly so we don't
    // re-trigger root-resolution through the tab manager.
    await loadFile(fileToOpen);
  } else {
    await autoSelectReadme();
  }
  // Keep the native Close Folder item in sync with the open state.
  await pushRecentsToNativeMenu();
  // Replace any existing watcher for this window. start_watch is
  // idempotent in the sense that the Rust side drops the previous one
  // before installing a new watch, so switching folders is safe.
  try {
    await invoke("start_watch", { root: path });
  } catch (e) {
    console.warn("start_watch failed:", e);
  }
}

async function closeFolder(): Promise<void> {
  rootPath = null;
  rootName = "";
  currentPath = [];
  activeFile = null;
  // Close all tabs so the doc area returns to the welcome state.
  // Restore-on-relaunch persists session.tabs separately; closing the
  // folder is an explicit "start fresh" gesture.
  await tabManager.restore([], null);
  sidebarTree.clear();
  breadcrumb.innerHTML = "";
  markdownEl.innerHTML = "";
  markdownEl.style.display = "none";
  emptyState.style.display = "block";
  contentEl.classList.add("empty");
  titlebarFilename.textContent = "";
  outlineNav.innerHTML = "";
  outlineEl.style.display = "none";
  setSearchEnabled(false);
  // Persist: clear session.folder so a fresh launch lands on the welcome
  // screen rather than reopening this closed folder.
  const store = await load(STORE_FILE);
  const current = await loadSession(store);
  await saveSession(store, { ...current, folder: null });
  await pushRecentsToNativeMenu();
  // Clear the backend's notion of "current root" so reveal_in_finder
  // tightens scope back to recents-only.
  invoke("register_current_root", { path: null }).catch((e) => {
    console.warn("register_current_root failed:", e);
  });
  try {
    await invoke("stop_watch");
  } catch (e) {
    console.warn("stop_watch failed:", e);
  }
}

async function openFolder(): Promise<void> {
  const selected = await open({ directory: true, multiple: false });
  if (selected) {
    await setRootPath(selected);
    await pushToRecents({
      kind: "folder",
      path: selected,
      displayName: extractRootName(selected),
    });
  }
}

// --- Filesystem ---

async function listEntries(dirPath: string): Promise<Entry[]> {
  const entries = await readDir(dirPath);
  return filterAndSortEntries(entries);
}

// --- Sidebar ---
//
// The flat single-folder list + breadcrumb used to live here. PR 3 swapped
// it for a recursive markdown-only tree (sidebar-tree.ts). `renderSidebar`
// is kept as the call-site entry point so existing callers don't need to
// know about the tree; it now just delegates to the SidebarTree instance
// and keeps the empty-state side effects centralized here.
async function renderSidebar(autoExpandRoot = true): Promise<void> {
  emptyState.style.display = "none";
  markdownEl.style.display = activeFile ? "block" : "none";
  if (!activeFile) {
    emptyState.style.display = "block";
    contentEl.classList.add("empty");
    titlebarFilename.textContent = "";
    setSearchEnabled(false);
  }
  breadcrumb.innerHTML = "";
  await refreshSidebarTree(autoExpandRoot);
}

// --- File loading ---

async function autoSelectReadme(): Promise<void> {
  const dirPath = getFullPath(rootPath!, currentPath);
  const entries = await listEntries(dirPath);
  const readme = findReadme(entries);
  if (readme) await loadFile([...currentPath, readme.name].join("/"));
}

function isRelativePath(src: string): boolean {
  return !(
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("asset://")
  );
}

function resolveImagePaths(container: HTMLElement, filePath: string): void {
  const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (src && isRelativePath(src)) {
      const absolutePath = `${dirPath}/${src}`;
      img.src = convertFileSrc(absolutePath);
    }
  }
}

async function loadFile(filePath: string): Promise<void> {
  try {
    const fullPath = `${rootPath}/${filePath}`;
    const text = await readTextFile(fullPath);

    activeFile = filePath;
    // Tell the backend this absolute path is now a "live document" so
    // commands that hand files to the OS (share_macos) accept it.
    invoke("register_active_doc", { path: fullPath }).catch((e) => {
      console.warn("register_active_doc failed:", e);
    });
    emptyState.style.display = "none";
    markdownEl.style.display = "block";
    contentEl.classList.remove("empty");

    markdownEl.innerHTML = parseMarkdown(text);
    resolveImagePaths(markdownEl, fullPath);
    contentEl.scrollTop = 0;

    await renderMermaidDiagrams();
    addCopyButtons(markdownEl);
    addImageLightbox(markdownEl, openImageOverlay);

    const fileDir = filePath.split("/").slice(0, -1);
    if (fileDir.join("/") !== currentPath.join("/")) {
      currentPath = fileDir;
    }

    const currentDir = filePath.split("/").slice(0, -1);
    interceptLinks(currentDir);
    sidebarTree.setActive(absoluteActiveFile());
    buildOutline();

    titlebarFilename.textContent = filePath.split("/").pop() ?? "";
    setSearchEnabled(true);
    searchController?.reset();
    // Save / Save As / Share / Print depend on a file being open — keep
    // the native menu's enabled state in sync.
    await pushRecentsToNativeMenu();
  } catch (e) {
    console.error("Failed to load file:", filePath, e);
  }
}

// --- Right outline ---

function buildOutline(): void {
  if (scrollObserver) scrollObserver.disconnect();

  const headings = markdownEl.querySelectorAll("h2, h3");
  outlineNav.innerHTML = "";

  if (headings.length === 0) {
    outlineEl.style.display = "none";
    return;
  }

  outlineEl.style.display = "block";
  const items: { el: HTMLAnchorElement; heading: Element }[] = [];

  for (const h of headings) {
    const item = document.createElement("a");
    item.className = "outline-item";
    if (h.tagName === "H3") item.classList.add("depth-3");
    item.textContent = h.textContent;
    item.dataset.targetId = h.id;
    item.addEventListener("click", () => {
      h.scrollIntoView({ behavior: "smooth" });
    });
    outlineNav.appendChild(item);
    items.push({ el: item, heading: h });
  }

  scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          for (const i of items) {
            i.el.classList.toggle("active", i.heading.id === id);
          }
        }
      }
    },
    {
      root: contentEl,
      rootMargin: "0px 0px -70% 0px",
      threshold: 0.1,
    }
  );

  for (const h of headings) {
    scrollObserver.observe(h);
  }
}

// --- Link interception ---

function interceptLinks(currentDir: string[]): void {
  for (const a of markdownEl.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;

    const linkType = classifyLink(href);

    if (linkType === "external") {
      a.classList.add("external-link");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openUrl(href);
      });
      continue;
    }

    if (linkType === "anchor") {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const id = href.slice(1);
        const target = markdownEl.querySelector(`#${CSS.escape(id)}`);
        if (target) target.scrollIntoView({ behavior: "smooth" });
      });
      continue;
    }

    if (linkType === "markdown") {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const { filePart, anchor } = parseMarkdownHref(href);
        const resolved = resolvePath([...currentDir], filePart);
        loadFile(resolved).then(() => {
          if (anchor) {
            const target = markdownEl.querySelector(`#${CSS.escape(anchor)}`);
            if (target) target.scrollIntoView({ behavior: "smooth" });
          }
        });
      });
    }
  }
}

init();
