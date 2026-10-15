import mermaid from "mermaid";
import "katex/dist/katex.min.css";
// The chrome's typefaces (Speakino's), bundled so they load offline and under the CSP.
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { load } from "@tauri-apps/plugin-store";
import { confirmDialog } from "./confirm-dialog";
import { createDebugOverlay } from "./debug-overlay";
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
  APPEARANCE_KEY,
  BODY_FONT_KEY,
  CODE_FONT_KEY,
  CUSTOM_FONT_SIZE_KEY,
  FONTSIZE_KEY,
  FONT_WEIGHT_KEY,
  MAX_CUSTOM_FONT_SIZE,
  MIN_CUSTOM_FONT_SIZE,
  FINDER_OPEN_KEY,
  LAUNCH_KEY,
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
  resolveInitialFinderOpenPref,
  resolveInitialLaunchPref,
  resolveInitialFontWeight,
  resolveInitialOutlinePref,
  changedSettings,
  setSegmentActive,
  settingsToWrite,
  settleWrite,
  type FinderOpenPref,
  type FontSize,
  type FontWeight,
  type LaunchPref,
  type OutlinePref,
} from "./preferences";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_ORDER,
  CUSTOM_THEMES_KEY,
  DAY_THEME_KEY,
  FOLLOW_SYSTEM_KEY,
  NIGHT_THEME_KEY,
  REQUIRED_VAR_KEYS,
  THEME_KEY,
  applyThemeToDOM,
  buildThemeCatalog,
  isTheme,
  mergeCustomThemes,
  parseTheme,
  resolveDisplayedThemeId,
  resolveFollowThemes,
  resolveInitialThemeId,
  type FollowThemes,
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
import type { Entry, LastRead, Listing, PendingOpen, RecentEntry } from "./utils";
import {
  MARKDOWN_EXTENSIONS,
  classifyLink,
  decodeAnchor,
  extractRootName,
  parentLabel,
  findReadme,
  getFullPath,
  isLastRead,
  isMarkdownName,
  listingStatusFromError,
  mergeRecent,
  parseMarkdownHref,
  resolveInitialView,
  resolvePath,
  shouldWriteLastRead,
  summarizeListing,
  windowTitle,
} from "./utils";
import {
  createNavigator,
  returnTarget,
  type CommitContext,
  type DecorationContext,
  type NavEntry,
  type Navigator as WindowNavigator,
  type Positioning,
} from "./navigator";
import { buildBreadcrumb, buildFileList, buildFolderView, buildHome, type HomeData } from "./screens";
import { appMark, icon } from "./icons";

// --- Theme & preferences management ---

const themeToggle = document.getElementById(
  "theme-toggle"
) as HTMLButtonElement;

// The theme shown when not following macOS, and the light/dark pair used when
// following it. Choosing a theme also fills the slot matching its appearance,
// so turning "follow macOS" on keeps the reader's latest choices.
let currentThemeId: ThemeId = "light";
let followSystem = false;
let followThemes: FollowThemes = { day: "light", night: "dark" };
let customThemes: Theme[] = [];
let themeCatalog: Record<ThemeId, Theme> = { ...BUILTIN_THEMES };
let currentBodyFont: string | null = null;
let currentCodeFont: string | null = null;
let currentFontWeight: FontWeight | null = null;
let currentCustomFontSize: number | null = null;
let finderOpenPref: FinderOpenPref = "new-window";
let launchPref: LaunchPref = "home";
const systemDarkMQ = window.matchMedia("(prefers-color-scheme: dark)");

function isDark(): boolean {
  return themeCatalog[activeThemeId()]?.isDark ?? false;
}

function activeThemeId(): ThemeId {
  return resolveDisplayedThemeId(
    themeCatalog,
    currentThemeId,
    followSystem,
    followThemes,
    systemDarkMQ.matches
  );
}

/**
 * Bring the fixed theme and the light/dark slots back in line with the
 * catalog after a theme was deleted, imported, renamed or switched between
 * light and dark: a slot always holds an existing theme of its appearance.
 */
function reconcileThemeChoices(renamed?: { from: ThemeId; to: ThemeId }): void {
  const rename = (id: ThemeId) =>
    renamed && id === renamed.from ? renamed.to : id;
  currentThemeId = rename(currentThemeId);
  if (!(currentThemeId in themeCatalog)) currentThemeId = "light";
  followThemes = resolveFollowThemes(
    themeCatalog,
    currentThemeId,
    rename(followThemes.day),
    rename(followThemes.night)
  );
}

type ThemeChoices = Record<string, ThemeId | boolean>;

/** Everything a theme save may write, so "before" and "after" compare alike. */
function themeChoices(): ThemeChoices {
  return {
    [THEME_KEY]: currentThemeId,
    [DAY_THEME_KEY]: followThemes.day,
    [NIGHT_THEME_KEY]: followThemes.night,
    [FOLLOW_SYSTEM_KEY]: followSystem,
  };
}

// Theme settings whose last write failed. They are written again, from this
// window's current values, with the next theme save. Known limit: if another
// app window wrote one of them in between, this window's value wins. That
// takes a failed write here followed by a successful write of the same key
// elsewhere.
const unsavedThemeKeys = new Set<string>();

/** Write theme settings; on failure, remember their keys for the next save. */
async function writeThemeSettings(
  entries: Record<string, unknown>
): Promise<void> {
  let ok = true;
  try {
    await savePrefs(entries);
  } catch {
    ok = false;
  }
  settleWrite(unsavedThemeKeys, entries, ok);
}

/**
 * Write the theme settings that changed since `before`, plus `forced` (what
 * the reader just chose), plus any whose last write failed, in one save.
 * Nothing else: another window may have chosen the other slot meanwhile,
 * and rewriting it from this window's memory would undo that.
 */
async function saveThemeChoices(
  before: ThemeChoices,
  forced: Record<string, unknown> = {}
): Promise<void> {
  const entries = settingsToWrite(
    themeChoices(),
    before,
    forced,
    unsavedThemeKeys
  );
  if (Object.keys(entries).length === 0) return;
  await writeThemeSettings(entries);
}

/** Choose a theme: it fills its light or dark slot, and is shown unless following macOS. */
async function selectTheme(
  id: ThemeId,
  before: ThemeChoices = themeChoices()
): Promise<void> {
  const theme = themeCatalog[id];
  if (!theme) return;
  reconcileThemeChoices();
  followThemes = theme.isDark
    ? { ...followThemes, night: id }
    : { ...followThemes, day: id };
  if (!followSystem) currentThemeId = id;
  applyActiveTheme();
  refreshThemeGridSelection();
  await saveThemeChoices(before, {
    [theme.isDark ? NIGHT_THEME_KEY : DAY_THEME_KEY]: id,
    ...(followSystem ? {} : { [THEME_KEY]: id }),
  });
}

function applyActiveTheme(): void {
  const id = activeThemeId();
  applyThemeToDOM(themeCatalog, document.documentElement, id);
  const dark = themeCatalog[id]?.isDark ?? false;
  themeToggle.innerHTML = icon(dark ? "sun" : "moon");
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    securityLevel: "loose",
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
  const savedDay = await store.get(DAY_THEME_KEY);
  const savedNight = await store.get(NIGHT_THEME_KEY);
  followThemes = resolveFollowThemes(
    themeCatalog,
    currentThemeId,
    savedDay,
    savedNight
  );
  // Settings from before the day/night slots (or a slot whose theme is gone):
  // write the derived pair now, so it no longer depends on the fixed theme,
  // which changes as soon as the reader turns "follow macOS" off.
  const derived = changedSettings(
    { [DAY_THEME_KEY]: savedDay, [NIGHT_THEME_KEY]: savedNight },
    { [DAY_THEME_KEY]: followThemes.day, [NIGHT_THEME_KEY]: followThemes.night }
  );
  if (Object.keys(derived).length > 0) {
    // Only the slot that was missing or invalid, best effort: a store that
    // cannot be written must not stop startup (retried with the next save).
    void writeThemeSettings(derived);
  }
  currentBodyFont = resolveInitialFontFamily(await store.get(BODY_FONT_KEY));
  currentCodeFont = resolveInitialFontFamily(await store.get(CODE_FONT_KEY));
  currentFontWeight = resolveInitialFontWeight(
    await store.get(FONT_WEIGHT_KEY)
  );
  currentCustomFontSize = resolveInitialCustomFontSize(
    await store.get(CUSTOM_FONT_SIZE_KEY)
  );
  finderOpenPref = resolveInitialFinderOpenPref(
    await store.get(FINDER_OPEN_KEY)
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

function printDocument(): void {
  // Native menu items stay enabled; there is nothing to print without a document.
  if (activeScreen() !== "doc") return;
  invoke("print_webview");
}

// The export captures the page as it is on screen, so navigation is held off
// from the save dialog until the capture is done, and only one export runs at
// a time.
async function exportPdf(): Promise<void> {
  if (activeScreen() !== "doc" || !activeFile) return;
  await nav.runExclusive(async () => {
    if (activeScreen() !== "doc" || !activeFile) return;
    const defaultName = activeFile
      .split("/")
      .pop()!
      .replace(/\.(md|markdown|mdx)$/i, ".pdf");

    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!outputPath) return;

    await nav.decorationsDone();
    document.body.classList.add("print-mode");
    try {
      await new Promise((r) => setTimeout(r, 150));
      await invoke("export_pdf", { outputPath });
    } finally {
      document.body.classList.remove("print-mode");
    }
  });
}

async function toggleTheme(): Promise<void> {
  // Swap to the other slot: the reader's light theme for their dark one.
  const before = themeChoices();
  reconcileThemeChoices();
  const activeId = activeThemeId();
  const newId = themeCatalog[activeId]?.isDark
    ? followThemes.day
    : followThemes.night;
  currentThemeId = newId;
  followSystem = false;
  applyActiveTheme();
  await saveThemeChoices(before, {
    [FOLLOW_SYSTEM_KEY]: false,
    [THEME_KEY]: newId,
  });
  syncPrefsUI();
  refreshThemeGridSelection();
}

const printBtn = document.getElementById("print-btn") as HTMLButtonElement;
printBtn.addEventListener("click", printDocument);

const pdfBtn = document.getElementById("pdf-btn") as HTMLButtonElement;
pdfBtn.addEventListener("click", exportPdf);

themeToggle.addEventListener("click", toggleTheme);

let mermaidCounter = 0;

// Mermaid is not safe for concurrent renders (shared temporary DOM): a pass
// taking over from an interrupted one queues behind it.
let mermaidQueue: Promise<unknown> = Promise.resolve();

function renderMermaidSerially(id: string, source: string): ReturnType<typeof mermaid.render> {
  const run = mermaidQueue.then(() => mermaid.render(id, source));
  mermaidQueue = run.catch(() => undefined);
  return run;
}

async function renderMermaidDiagrams(isCurrent: () => boolean = () => true): Promise<void> {
  const codeBlocks = markdownEl.querySelectorAll("pre > code.language-mermaid");
  if (codeBlocks.length === 0) return;

  for (const codeBlock of codeBlocks) {
    // Rendering is async: stop as soon as another view has replaced this one.
    if (!isCurrent()) return;
    const pre = codeBlock.parentElement!;
    const source = codeBlock.textContent ?? "";
    const id = `mermaid-${++mermaidCounter}`;

    let title = t("mermaid.diagram");
    const prevEl = pre.previousElementSibling;
    if (prevEl && /^H[2-4]$/.test(prevEl.tagName)) {
      title = prevEl.textContent ?? title;
    }

    try {
      const { svg } = await renderMermaidSerially(id, source);
      if (!isCurrent()) {
        document.getElementById(id)?.remove();
        return;
      }

      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-wrapper";

      const btn = document.createElement("button");
      btn.className = "mermaid-fullscreen-btn";
      btn.type = "button";
      btn.textContent = t("mermaid.fullscreen");
      btn.addEventListener("click", () => openMermaidFullscreen(svg, title));

      const preview = document.createElement("div");
      preview.className = "mermaid-preview";
      preview.innerHTML = svg;

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
      if (!isCurrent()) return;
      console.warn("Mermaid render failed for diagram", id, e);
      const errWrapper = document.createElement("div");
      errWrapper.className = "mermaid-wrapper";
      errWrapper.style.borderColor = "#ef4444";
      const errMsg = document.createElement("div");
      errMsg.className = "mermaid-error-msg";
      errMsg.style.cssText = "padding:12px 16px;font-size:12px;color:#ef4444;";
      errMsg.textContent = t("mermaid.error");
      const srcPre = document.createElement("pre");
      srcPre.style.cssText = "margin:0;border-radius:0 0 8px 8px;";
      const srcCode = document.createElement("code");
      srcCode.textContent = source;
      srcPre.appendChild(srcCode);
      errWrapper.appendChild(errMsg);
      errWrapper.appendChild(srcPre);
      addCopyButtons(errWrapper);
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

  // Reveal synchronously — see confirm-dialog.ts.
  void overlay.offsetHeight;
  overlay.classList.add("visible");
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
  body.innerHTML = svgContent;

  const svg = body.querySelector("svg");
  if (svg) {
    svg.removeAttribute("width");
    svg.style.maxWidth = "95vw";
    svg.style.height = "auto";
  }

  overlay.appendChild(header);
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  // Reveal synchronously — see confirm-dialog.ts.
  void overlay.offsetHeight;
  overlay.classList.add("visible");
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
const breadcrumb = document.getElementById("breadcrumb") as HTMLElement;
const markdownEl = document.getElementById("markdown") as HTMLDivElement;
const homeEl = document.getElementById("home") as HTMLElement;
const folderViewEl = document.getElementById("folder-view") as HTMLElement;
const docCard = document.getElementById("doc-card") as HTMLDivElement;
const sidebarEl = document.getElementById("sidebar") as HTMLDivElement;
const sidebarScrim = document.getElementById("sidebar-scrim") as HTMLDivElement;
const sidebarCount = document.getElementById("sidebar-count") as HTMLSpanElement;
const folderSwitcher = document.getElementById("folder-switcher") as HTMLButtonElement;
const folderSwitcherName = document.getElementById("folder-switcher-name") as HTMLSpanElement;
const folderSwitcherPath = document.getElementById("folder-switcher-path") as HTMLSpanElement;
const folderMenu = document.getElementById("folder-menu") as HTMLDivElement;
const navBackBtn = document.getElementById("nav-back") as HTMLButtonElement;
const navForwardBtn = document.getElementById("nav-forward") as HTMLButtonElement;
const navHomeBtn = document.getElementById("nav-home") as HTMLButtonElement;
const sidebarToggle = document.getElementById("sidebar-toggle") as HTMLButtonElement;
const sidebarClose = document.getElementById("sidebar-close") as HTMLButtonElement;
const outlineToggle = document.getElementById("outline-toggle") as HTMLButtonElement;
const searchToggle = document.getElementById("search-toggle") as HTMLButtonElement;
const searchBoxEl = document.getElementById("search-box") as HTMLDivElement;
const navSpinner = document.getElementById("nav-spinner") as HTMLSpanElement;
const srStatus = document.getElementById("sr-status") as HTMLSpanElement;
const prefsBtn = document.getElementById("prefs-btn") as HTMLButtonElement;
const contentEl = document.getElementById("content") as HTMLDivElement;
const contentLoading = document.getElementById(
  "content-loading"
) as HTMLDivElement;
const slowReadNotice = document.getElementById(
  "slow-read-notice"
) as HTMLDivElement;
const slowReadDismiss = document.getElementById(
  "slow-read-dismiss"
) as HTMLButtonElement;
const loadError = document.getElementById("load-error") as HTMLDivElement;
const loadErrorText = document.getElementById(
  "load-error-text"
) as HTMLSpanElement;
const outlineEl = document.getElementById("outline") as HTMLDivElement;
const outlineNav = document.getElementById("outline-nav") as HTMLElement;
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

const appWindow = getCurrentWindow();

// In full screen the traffic lights are gone: the title bar can drop the room
// it keeps for them (WKWebView never reports env(titlebar-area-x)).
async function syncFullscreen(): Promise<void> {
  try {
    document.documentElement.classList.toggle(
      "is-fullscreen",
      await appWindow.isFullscreen()
    );
  } catch {
    // Not in Tauri (tests) or not allowed: keep the room for the lights.
  }
}
// Resize events fire during the full-screen animation, before the window
// reports its new state, and no event marks the end of it: check again a few
// times over the next seconds.
let fullscreenRechecks: ReturnType<typeof setTimeout>[] = [];
void appWindow
  .onResized(() => {
    void syncFullscreen();
    for (const timer of fullscreenRechecks) clearTimeout(timer);
    fullscreenRechecks = [300, 900, 2000].map((ms) =>
      setTimeout(() => void syncFullscreen(), ms)
    );
  })
  .catch(() => {});
void syncFullscreen();

// Keeps the native window title in sync with what the window shows. The title is
// hidden in our custom title bar; it exists so this window is identifiable in the
// native Window menu, which is why renaming goes through the Rust command that
// also refreshes that menu.
function syncWindowTitle(): void {
  void invoke("set_window_title", {
    title: windowTitle(activeFile, rootName),
  }).catch((e) => console.warn("Failed to set the window title:", e));
}

// --- Window state ---
// What the committed view shows. Only the navigator's publish step writes these.
let rootPath: string | null = null;
let rootName = "";
let currentPath: string[] = [];
let activeFile: string | null = null;
let scrollObserver: IntersectionObserver | null = null;

const STORE_FILE = "settings.json";
const STORE_KEY = "lastFolder";
const RECENT_KEY = "recentEntries";
const LAST_READ_KEY = "lastRead";
const RECENT_MAX = 10;

// --- Store persistence ---

async function saveRootPath(path: string): Promise<void> {
  const store = await load(STORE_FILE);
  await store.set(STORE_KEY, path);
  await store.save();
}

/** Forget the last folder, unless another window has saved a different one since. */
async function forgetRootPath(path: string): Promise<void> {
  const store = await load(STORE_FILE);
  if ((await store.get(STORE_KEY)) !== path) return;
  await store.delete(STORE_KEY);
  await store.save();
}

async function loadRootPath(): Promise<string | null> {
  const store = await load(STORE_FILE);
  return ((await store.get(STORE_KEY)) as string) ?? null;
}

// --- Recent files/folders ---
// State lives here in the store; the native "Open Recent" submenu is rebuilt in
// Rust via `update_recent_menu` whenever the list changes.

async function loadRecents(): Promise<RecentEntry[]> {
  const store = await load(STORE_FILE);
  return ((await store.get(RECENT_KEY)) as RecentEntry[]) ?? [];
}

async function syncRecentMenu(entries: RecentEntry[]): Promise<void> {
  const items = entries.map((e) => ({
    path: e.path,
    kind: e.kind,
    label: e.path.split("/").pop() || e.path,
  }));
  await invoke("update_recent_menu", { items });
}

async function recordRecent(path: string, kind: "file" | "folder"): Promise<void> {
  const store = await load(STORE_FILE);
  const list = ((await store.get(RECENT_KEY)) as RecentEntry[]) ?? [];
  const next = mergeRecent(list, { path, kind }, RECENT_MAX);
  await store.set(RECENT_KEY, next);
  await store.save();
  await syncRecentMenu(next);
}

async function clearRecents(): Promise<void> {
  const store = await load(STORE_FILE);
  await store.set(RECENT_KEY, []);
  await store.save();
  await syncRecentMenu([]);
  if (activeScreen() === "home") void refreshHome();
}

// --- Last document read ("Reprendre") ---
// Shared by every window through the store. Written only on reading activity
// (opening a document, scrolling it), never when a window closes, so a window
// left on an old document cannot pass it off as the latest read.

async function loadLastRead(): Promise<LastRead | null> {
  const store = await load(STORE_FILE);
  const value = await store.get(LAST_READ_KEY);
  return isLastRead(value) ? value : null;
}

async function writeLastRead(next: LastRead): Promise<void> {
  try {
    const store = await load(STORE_FILE);
    if (!shouldWriteLastRead(await store.get(LAST_READ_KEY), next)) return;
    await store.set(LAST_READ_KEY, next);
    await store.save();
  } catch (e) {
    console.warn("Failed to save the last document read:", e);
  }
}

let lastReadTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLastRead: LastRead | null = null;

function scheduleLastRead(snapshot: LastRead): void {
  pendingLastRead = snapshot;
  if (lastReadTimer !== null) clearTimeout(lastReadTimer);
  lastReadTimer = setTimeout(() => {
    lastReadTimer = null;
    if (pendingLastRead) void writeLastRead(pendingLastRead);
    pendingLastRead = null;
  }, 1000);
}

// --- Opening folders and files ---

async function openFolderPath(path: string): Promise<void> {
  const ok = await nav.navigate({ kind: "folder", rootPath: path, dir: [] });
  // A folder that cannot be listed is shown (its view says why), not promoted.
  if (ok && committedListing?.status === "ok") {
    await saveRootPath(path);
    await recordRecent(path, "folder");
  }
}

async function openExamples(): Promise<void> {
  const examplesPath = await resolveResource("examples");
  await openFolderPath(examplesPath);
}

function docEntry(root: string, file: string, anchor?: string): NavEntry {
  return { kind: "doc", rootPath: root, dir: file.split("/").slice(0, -1), file, anchor };
}

/** Open a document; the one already on screen is read again (it may have changed). */
function openDocument(root: string, file: string): Promise<boolean> {
  if (activeScreen() === "doc" && root === rootPath && file === activeFile) return nav.reload();
  return nav.navigate(docEntry(root, file));
}

async function openFileFromPath(filePath: string): Promise<void> {
  const lastSep = filePath.lastIndexOf("/");
  const parentDir = filePath.substring(0, lastSep);
  const fileName = filePath.substring(lastSep + 1);
  const ok = await openDocument(parentDir, fileName);
  if (ok) {
    await saveRootPath(parentDir);
    await recordRecent(filePath, "file");
  }
}

// --- Debug HUD ---

const debugOverlay = createDebugOverlay();

// --- Search ---

let searchController: SearchController | null = null;

// Disabling keeps the query: it runs again on the next document, as before.
function setSearchEnabled(enabled: boolean): void {
  searchInput.disabled = !enabled;
  searchPrev.disabled = !enabled;
  searchNext.disabled = !enabled;
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
      foldSearch(true);
    }
  }
}

/**
 * Fold the compact search field (narrow windows) back behind its button.
 * From the keyboard (Escape) focus goes to the button; a click elsewhere
 * leaves focus to the click.
 */
function foldSearch(fromKeyboard = false): void {
  if (!document.body.classList.contains("search-open")) return;
  document.body.classList.remove("search-open");
  searchOptionsMenu.classList.remove("visible");
  searchOptionsBtn.setAttribute("aria-expanded", "false");
  if (fromKeyboard && searchToggle.getClientRects().length > 0) searchToggle.focus();
}

// Same breakpoint as the CSS that folds the search field.
const compactSearchMQ = window.matchMedia("(max-width: 1000px)");

function focusSearch(): void {
  if (searchInput.disabled) {
    return;
  }
  // In a narrow window the field is folded behind a button: unfold it first.
  if (compactSearchMQ.matches) document.body.classList.add("search-open");
  searchInput.focus();
  searchInput.select();
}

function handleGlobalSearchShortcut(e: KeyboardEvent): void {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) {
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "d" && e.shiftKey) {
    e.preventDefault();
    debugOverlay.toggle();
    return;
  }
  if (key === "f" && !searchInput.disabled) {
    e.preventDefault();
    focusSearch();
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
}

// --- Preferences modal ---

const prefsBackdrop = document.getElementById(
  "prefs-backdrop"
) as HTMLDivElement;
const prefsClose = document.getElementById("prefs-close") as HTMLButtonElement;
const prefsFontSize = document.getElementById(
  "prefs-fontsize"
) as HTMLDivElement;
const prefsOutline = document.getElementById("prefs-outline") as HTMLDivElement;
const prefsOutlineHint = document.getElementById(
  "prefs-outline-hint"
) as HTMLParagraphElement;
const prefsFinderOpen = document.getElementById(
  "prefs-finder-open"
) as HTMLSelectElement;
const prefsLaunch = document.getElementById("prefs-launch") as HTMLSelectElement;
const prefsTabs = document.querySelectorAll<HTMLButtonElement>(".prefs-tab");
const prefsTabPanels =
  document.querySelectorAll<HTMLDivElement>(".prefs-tab-panel");
const prefsThemeGridLight = document.getElementById(
  "prefs-theme-grid-light"
) as HTMLDivElement;
const prefsThemeGridDark = document.getElementById(
  "prefs-theme-grid-dark"
) as HTMLDivElement;
const prefsGridLightLabel = document.getElementById(
  "prefs-grid-light-label"
) as HTMLHeadingElement;
const prefsGridDarkLabel = document.getElementById(
  "prefs-grid-dark-label"
) as HTMLHeadingElement;
const prefsThemeSentence = document.getElementById(
  "prefs-theme-sentence"
) as HTMLParagraphElement;
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
const prefsAdvancedReset = document.getElementById(
  "prefs-advanced-reset"
) as HTMLButtonElement;
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
  setSegmentActive(
    prefsFontSize,
    (document.documentElement.dataset.fontsize as FontSize) ?? "medium"
  );
  syncOutlineUI(
    (document.documentElement.dataset.outline as OutlinePref) ?? "auto"
  );
  prefsFinderOpen.value = finderOpenPref;
  prefsLaunch.value = launchPref;
  // The selects take their width once their values (and fonts) are set.
  requestAnimationFrame(fitInlineSelects);
  prefsBodyFont.value = currentBodyFont ?? "";
  prefsCodeFont.value = currentCodeFont ?? "";
  prefsFontWeight.value = currentFontWeight ?? "";
  prefsCustomSize.value =
    currentCustomFontSize !== null ? String(currentCustomFontSize) : "";
}

// A <select> is as wide as its longest option; inside a sentence it should
// be as wide as the choice it shows.
let selectProbe: HTMLSpanElement | null = null;

function fitInlineSelect(select: HTMLSelectElement): void {
  if (!selectProbe) {
    selectProbe = document.createElement("span");
    selectProbe.setAttribute("aria-hidden", "true");
    selectProbe.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
    document.body.append(selectProbe);
  }
  const style = getComputedStyle(select);
  selectProbe.style.font = style.font;
  selectProbe.style.fontWeight = style.fontWeight;
  const shown = select.selectedOptions[0]?.textContent;
  // No matching option (fonts not listed yet): keep the natural width.
  if (!shown) {
    select.style.width = "";
    return;
  }
  selectProbe.textContent = shown;
  const pad =
    parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2;
  select.style.width = `${Math.ceil(selectProbe.offsetWidth + pad)}px`;
}

function fitInlineSelects(): void {
  for (const select of prefsBackdrop.querySelectorAll<HTMLSelectElement>(
    "select.prefs-inline"
  )) {
    fitInlineSelect(select);
  }
}

function syncOutlineUI(pref: OutlinePref): void {
  setSegmentActive(prefsOutline, pref);
  prefsOutlineHint.textContent = t(`prefs.outline.hint.${pref}`);
}

/** The themes in use: both slots while following macOS, else the fixed one. */
function chosenThemeIds(): Set<ThemeId> {
  return followSystem
    ? new Set([followThemes.day, followThemes.night])
    : new Set([currentThemeId]);
}

function themeNameSpan(id: ThemeId): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "prefs-theme-name-inline";
  span.textContent = themeCatalog[id]?.name ?? id;
  return span;
}

function refreshThemeGridSelection(): void {
  const chosen = chosenThemeIds();
  for (const grid of [prefsThemeGridLight, prefsThemeGridDark]) {
    for (const tile of grid.querySelectorAll<HTMLButtonElement>(
      ".prefs-theme-tile"
    )) {
      const on = chosen.has(tile.dataset.themeId ?? "");
      tile.classList.toggle("active", on);
      tile.setAttribute("aria-pressed", String(on));
    }
  }
  prefsGridLightLabel.textContent = t(
    followSystem ? "prefs.themes.day" : "prefs.themes.light"
  );
  prefsGridDarkLabel.textContent = t(
    followSystem ? "prefs.themes.night" : "prefs.themes.dark"
  );
  // "By day, read in X. By night, in Y." or "Always read in X."
  if (followSystem) {
    prefsThemeSentence.replaceChildren(
      `${t("prefs.themes.day.before")} `,
      themeNameSpan(followThemes.day),
      `${t("prefs.themes.night.before")} `,
      themeNameSpan(followThemes.night),
      t("prefs.sentence.end")
    );
  } else {
    prefsThemeSentence.replaceChildren(
      `${t("prefs.themes.fixed.before")} `,
      themeNameSpan(currentThemeId),
      t("prefs.sentence.end")
    );
  }
}

function buildThemeGrid(): void {
  prefsThemeGridLight.replaceChildren();
  prefsThemeGridDark.replaceChildren();
  const order: ThemeId[] = [
    ...BUILTIN_THEME_ORDER,
    ...customThemes
      .map((c) => c.id)
      .filter((id) => !(id in BUILTIN_THEMES)),
  ];
  for (const id of order) {
    const theme = themeCatalog[id];
    if (!theme) continue;
    (theme.isDark ? prefsThemeGridDark : prefsThemeGridLight).appendChild(
      buildThemeTile(theme)
    );
  }
}

function buildThemeTile(theme: Theme): HTMLDivElement {
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
  nameRow.appendChild(nameSpan);

  tile.appendChild(preview);
  tile.appendChild(nameRow);

  tile.addEventListener("click", () => selectTheme(theme.id));

  // Edit, duplicate and delete sit beside the tile, not inside it: a button
  // cannot hold buttons, and each must be reachable from the keyboard.
  const cell = document.createElement("div");
  cell.className = "prefs-theme-cell";
  const actions = document.createElement("div");
  actions.className = "prefs-theme-actions";
  const action = (
    kind: string,
    glyph: string,
    labelKey: string,
    run: () => void
  ): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `prefs-theme-action ${kind}`;
    b.textContent = glyph;
    const label = `${t(labelKey)} — ${theme.name}`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", run);
    actions.append(b);
  };

  if (theme.custom) {
    tile.classList.add("custom");
    action("edit", "✎", "prefs.appearance.edit", () =>
      openEditor(theme, { editing: true })
    );
  }
  action("duplicate", "⧉", "prefs.appearance.duplicate", () =>
    openEditor({ ...theme, custom: true }, { duplicateFrom: theme.id })
  );
  if (theme.custom) {
    action("delete", "×", "prefs.appearance.delete", async () => {
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
  }

  cell.append(tile, actions);
  return cell;
}

async function deleteCustomTheme(id: ThemeId): Promise<void> {
  const before = themeChoices();
  customThemes = customThemes.filter((c) => c.id !== id);
  themeCatalog = buildThemeCatalog(customThemes);
  reconcileThemeChoices();
  await saveThemeChoices(before);
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
  buildThemeGrid();
  await selectTheme(theme.id);
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
  const before = themeChoices();
  const originalId = prefsEditorId.dataset.originalId;
  if (editorContext.editing && originalId && originalId !== id) {
    // A renamed theme keeps its place as the fixed theme and in its slot.
    reconcileThemeChoices({ from: originalId, to: id });
  }
  buildThemeGrid();
  await selectTheme(theme.id, before);
  editorPreviewSnapshot = null; // committed; no rollback
  closeEditor(false);
}

let prefsFocusTrap: FocusTrap | null = null;
// Bumped on every open so a pending close callback can tell whether it still
// owns the panel — see closePrefs.
let prefsGeneration = 0;

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
  // Reveal synchronously — see confirm-dialog.ts.
  prefsGeneration++;
  prefsBackdrop.style.display = "flex";
  void prefsBackdrop.offsetHeight;
  prefsBackdrop.classList.add("visible");
  void populateFontDropdowns();
  prefsFocusTrap?.release();
  // Open with focus on the active tab rather than the close (×) button, which
  // is the default first-focusable. Tabs are a more meaningful entry point.
  prefsFocusTrap = trapFocus(prefsBackdrop, {
    initialFocus: () => getActiveTabButton(),
  });
}

function closePrefs(): void {
  prefsBackdrop.classList.remove("visible");
  const generation = prefsGeneration;
  setTimeout(() => {
    // Skip if Preferences were reopened during the fade-out: this callback
    // would otherwise hide a panel the user just asked for, and wipe its state
    // underneath them. Same ownership problem as confirm-dialog.ts.
    if (generation !== prefsGeneration) return;
    prefsBackdrop.style.display = "none";
    // Reset transient UI state so the next open lands on a clean default:
    // - close the theme editor if it was open (no preview rollback needed —
    //   user explicitly closed the modal, treat it as a Cancel),
    // - jump to the General tab,
    // - reset the body scroll to the top.
    if (prefsPanelAppearance.classList.contains("prefs-editor-mode")) {
      closeEditor(true);
    }
    setActiveTab("general");
    const body = prefsBackdrop.querySelector<HTMLDivElement>(".prefs-body");
    if (body) body.scrollTop = 0;
  }, 180);
  prefsFocusTrap?.release();
  prefsFocusTrap = null;
}

async function savePref<T>(key: string, value: T): Promise<void> {
  await savePrefs({ [key]: value });
}

// Writes run one after another, in the order they were asked for: two quick
// changes can never land in the store the other way round.
let prefsWrites: Promise<void> = Promise.resolve();

/** Several settings that belong together, written in one save. */
function savePrefs(entries: Record<string, unknown>): Promise<void> {
  const write = prefsWrites.then(async () => {
    const store = await load(STORE_FILE);
    for (const [key, value] of Object.entries(entries)) {
      await store.set(key, value);
    }
    await store.save();
  });
  prefsWrites = write.catch((e) => console.warn("Failed to save settings:", e));
  return write;
}

/** Radio groups of buttons: one Tab stop, arrow keys move the choice. */
function wireRadioGroup(group: HTMLElement): void {
  group.addEventListener("keydown", (e) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    const radios = Array.from(
      group.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    );
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length];
    next.focus();
    next.click();
  });
}

function initPreferences(): void {
  wireRadioGroup(prefsOutline);
  wireRadioGroup(prefsFontSize);
  prefsBackdrop.addEventListener("change", (e) => {
    const target = e.target;
    if (
      target instanceof HTMLSelectElement &&
      target.classList.contains("prefs-inline")
    ) {
      fitInlineSelect(target);
    }
  });
  document.getElementById("prefs-mark")!.innerHTML = appMark(46);
  prefsClose.addEventListener("click", closePrefs);
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
    // Turning it off keeps the theme on screen as the fixed one.
    const before = themeChoices();
    if (!prefsFollowSystem.checked) currentThemeId = activeThemeId();
    followSystem = prefsFollowSystem.checked;
    applyActiveTheme();
    refreshThemeGridSelection();
    await saveThemeChoices(before, {
      [FOLLOW_SYSTEM_KEY]: followSystem,
      ...(followSystem ? {} : { [THEME_KEY]: currentThemeId }),
    });
  });

  prefsLanguage.addEventListener("change", async () => {
    const value = prefsLanguage.value;
    if (!isLocale(value)) return;
    setLocale(value as Locale);
    document.documentElement.lang = value;
    applyTranslations(document);
    // Home, folder view, sidebar, breadcrumb and a few labels inside the
    // document are built in JS: rebuild them in the new language.
    relabelScreen();
    // The outline hint, the theme sentence and the theme actions' labels are
    // written in JS too.
    buildThemeGrid();
    syncPrefsUI();
    await savePref(LOCALE_KEY, value);
  });

  prefsImportTheme.addEventListener("click", async () => {
    prefsImportError.style.display = "none";
    const selected = await open({
      multiple: false,
      filters: [{ name: "Theme JSON", extensions: ["json"] }],
    });
    if (!selected || typeof selected !== "string") return;
    // An unreadable or invalid file, and a valid theme that could not be
    // stored, are different problems: say which one happened.
    let message: string | null = null;
    let text: string | null = null;
    try {
      text = await readTextFile(selected);
    } catch {
      message = t("prefs.appearance.import.error");
    }
    if (text !== null) {
      try {
        if (!(await importCustomTheme(text))) {
          message = t("prefs.appearance.import.error");
        }
      } catch (e) {
        console.warn("Theme import failed:", e);
        message = t("prefs.appearance.import.saveError");
      }
    }
    if (message) {
      prefsImportError.textContent = message;
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

  for (const btn of prefsFontSize.querySelectorAll<HTMLButtonElement>(
    "button"
  )) {
    btn.addEventListener("click", async () => {
      const value = btn.dataset.value as FontSize;
      applyFontSize(value);
      setSegmentActive(prefsFontSize, value);
      await savePref(FONTSIZE_KEY, value);
    });
  }

  for (const btn of prefsOutline.querySelectorAll<HTMLButtonElement>(
    "button"
  )) {
    btn.addEventListener("click", async () => {
      const value = btn.dataset.value as OutlinePref;
      applyOutlinePref(value);
      syncOutlineUI(value);
      await savePref(OUTLINE_PREF_KEY, value);
    });
  }

  prefsFinderOpen.addEventListener("change", async () => {
    const value = prefsFinderOpen.value as FinderOpenPref;
    finderOpenPref = value;
    await savePref(FINDER_OPEN_KEY, value);
  });

  prefsLaunch.addEventListener("change", async () => {
    const value = prefsLaunch.value as LaunchPref;
    launchPref = value;
    await savePref(LAUNCH_KEY, value);
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

// --- Chrome: sidebar overlay, folder menu, outline popover ---

const NARROW_SIDEBAR = 860;
let sidebarOpener: HTMLElement | null = null;

function setSidebarOpen(open: boolean): void {
  const wasOpen = document.body.classList.contains("sidebar-open");
  if (open === wasOpen) return;
  document.body.classList.toggle("sidebar-open", open);
  sidebarToggle.setAttribute("aria-expanded", String(open));
  sidebarScrim.hidden = !open;
  // While the panel covers the page, the page behind it is out of reach.
  for (const el of [document.getElementById("titlebar"), docCard, folderViewEl]) {
    if (el) el.inert = open;
  }
  if (open) {
    sidebarEl.setAttribute("role", "dialog");
    sidebarEl.setAttribute("aria-modal", "true");
    sidebarOpener = document.activeElement as HTMLElement | null;
    (sidebarEl.querySelector<HTMLElement>(".file-item.active, .file-item") ?? sidebarClose).focus();
  } else {
    sidebarEl.removeAttribute("role");
    sidebarEl.removeAttribute("aria-modal");
    focusVisible(sidebarOpener);
    sidebarOpener = null;
  }
}

/** Focus `el` if it is on screen, otherwise the document so focus is not lost. */
function focusVisible(el: HTMLElement | null): void {
  if (el && el.getClientRects().length > 0) {
    el.focus();
  } else if (activeScreen() === "doc") {
    contentEl.focus({ preventScroll: true });
  }
}

function setOutlineOpen(open: boolean): void {
  document.body.classList.toggle("outline-open", open);
  outlineToggle.setAttribute("aria-expanded", String(open));
  if (open) outlineNav.querySelector<HTMLElement>(".outline-item")?.focus();
}

function closeFolderMenu(returnFocus = false): void {
  folderMenuOpening = false;
  if (folderMenu.hidden) return;
  folderMenu.hidden = true;
  folderSwitcher.setAttribute("aria-expanded", "false");
  if (returnFocus) focusVisible(folderSwitcher);
}

/** Close every popover and panel; a new view never opens under one. */
function closeTransientUI(): void {
  closeFolderMenu();
  setOutlineOpen(false);
  setSidebarOpen(false);
}

function menuItem(
  label: string,
  onSelect: () => void,
  shortcut?: string,
  checked = false,
  returnFocus = true
): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "menu-item";
  item.setAttribute("role", checked ? "menuitemradio" : "menuitem");
  if (checked) item.setAttribute("aria-checked", "true");
  const text = document.createElement("span");
  text.className = "menu-item-label";
  text.textContent = label;
  item.append(text);
  if (checked) item.insertAdjacentHTML("beforeend", icon("check", 14));
  if (shortcut) {
    const k = document.createElement("span");
    k.className = "menu-item-shortcut mono";
    k.textContent = shortcut;
    item.append(k);
  }
  item.addEventListener("click", () => {
    closeFolderMenu(returnFocus);
    onSelect();
  });
  return item;
}

function menuSeparator(): HTMLElement {
  const sep = document.createElement("div");
  sep.className = "menu-sep";
  sep.setAttribute("role", "separator");
  return sep;
}

let folderMenuOpening = false;
let folderMenuSeq = 0;

async function openFolderMenu(): Promise<void> {
  folderMenuOpening = true;
  const seq = ++folderMenuSeq;
  const recents = (await loadRecents()).filter((e) => e.kind === "folder").slice(0, 5);
  // Closed (second click, Escape) or reopened while the recents were loading.
  if (!folderMenuOpening || seq !== folderMenuSeq) return;
  folderMenuOpening = false;
  const items: HTMLElement[] = [];
  if (recents.length > 0) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.setAttribute("role", "presentation");
    label.textContent = t("folderMenu.recents");
    items.push(label);
    for (const entry of recents) {
      items.push(
        menuItem(extractRootName(entry.path), () => void openFolderPath(entry.path), undefined, entry.path === rootPath)
      );
    }
    items.push(menuSeparator());
  }
  items.push(menuItem(t("folderMenu.open"), () => void openFolder(), "⇧⌘O"));
  items.push(menuItem(t("folderMenu.newWindow"), () => void openFolderInNewWindow(), "⇧⌘N"));
  items.push(menuSeparator());
  // Closing leads home, where the switcher is gone: focus goes to the page instead.
  items.push(menuItem(t("folder.close"), closeFolder, "⇧⌘W", false, false));
  folderMenu.replaceChildren(...items);
  folderMenu.hidden = false;
  folderSwitcher.setAttribute("aria-expanded", "true");
  folderMenu.querySelector<HTMLElement>(".menu-item")?.focus();
}

folderMenu.addEventListener("keydown", (e) => {
  const items = Array.from(folderMenu.querySelectorAll<HTMLElement>(".menu-item"));
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    items[e.key === "Home" ? 0 : items.length - 1]?.focus();
  } else if (e.key === "Escape") {
    // Only the menu closes, not the sidebar panel it sits in.
    e.preventDefault();
    e.stopPropagation();
    closeFolderMenu(true);
  } else if (e.key === "Tab") {
    // Leave from the switcher so Tab moves on from there.
    closeFolderMenu(true);
  }
});

document.addEventListener("click", (e) => {
  const target = e.target as Node;
  if (!folderMenu.hidden && !folderMenu.contains(target) && !folderSwitcher.contains(target)) {
    closeFolderMenu();
  }
  if (
    document.body.classList.contains("outline-open") &&
    !outlineEl.contains(target) &&
    !outlineToggle.contains(target)
  ) {
    setOutlineOpen(false);
  }
});

document.addEventListener("keydown", (e) => {
  // ⌘↑: up to the enclosing folder, as in the Finder — but never while typing.
  if (e.key === "ArrowUp" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !isEditable(e.target)) {
    if (!modalOpen() && rootPath !== null && activeScreen() !== "home") {
      e.preventDefault();
      goUp();
    }
    return;
  }
  if (e.key !== "Escape" || modalOpen() || e.defaultPrevented) return;
  if (document.body.classList.contains("sidebar-open")) {
    setSidebarOpen(false);
  } else if (document.body.classList.contains("outline-open")) {
    setOutlineOpen(false);
    outlineToggle.focus();
  }
});

/** Fields where ⌘↑ moves the caret or changes the value (not checkboxes or buttons). */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  return !["checkbox", "radio", "button", "submit", "reset", "color", "range"].includes((el as HTMLInputElement).type);
}

function initChrome(): void {
  navBackBtn.addEventListener("click", () => void nav.back());
  navForwardBtn.addEventListener("click", () => void nav.forward());
  navHomeBtn.addEventListener("click", goHome);
  sidebarToggle.addEventListener("click", () => setSidebarOpen(!document.body.classList.contains("sidebar-open")));
  sidebarClose.addEventListener("click", () => setSidebarOpen(false));
  sidebarScrim.addEventListener("click", () => setSidebarOpen(false));
  outlineToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setOutlineOpen(!document.body.classList.contains("outline-open"));
  });
  searchToggle.addEventListener("click", () => {
    document.body.classList.add("search-open");
    focusSearch();
  });
  // Escape from the field's buttons folds it too (the field handles its own).
  searchBoxEl.addEventListener("keydown", (e) => {
    // Only when the field is folded open: otherwise Escape belongs to the
    // other handlers (closing the outline popover…).
    if (
      e.key === "Escape" &&
      e.target !== searchInput &&
      !searchInput.value &&
      document.body.classList.contains("search-open")
    ) {
      e.preventDefault();
      foldSearch(true);
    }
  });

  // Fold the compact field back on a click outside the search UI when there is
  // no query. Not on focusout: WebKit does not focus buttons on click, so the
  // field would fold under the pointer before its own buttons get the click.
  document.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("search-open") || searchInput.value) return;
    const target = e.target as Node;
    if (searchBoxEl.contains(target) || searchOptionsMenu.contains(target) || searchToggle.contains(target)) return;
    foldSearch();
  });
  prefsBtn.addEventListener("click", openPrefs);
  folderSwitcher.addEventListener("click", (e) => {
    e.stopPropagation();
    if (folderMenu.hidden && !folderMenuOpening) void openFolderMenu();
    else closeFolderMenu(true);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > NARROW_SIDEBAR) setSidebarOpen(false);
  });
  // The window shows what other windows did meanwhile (recents, last read).
  window.addEventListener("focus", () => {
    if (activeScreen() === "home") void refreshHome();
  });
  syncNavButtons();
}

// --- Init ---

async function init(): Promise<void> {
  // 1. Preferences that decide where opens go, before anything can open.
  const routingStore = await load(STORE_FILE);
  finderOpenPref = resolveInitialFinderOpenPref(await routingStore.get(FINDER_OPEN_KEY));
  launchPref = resolveInitialLaunchPref(await routingStore.get(LAUNCH_KEY));

  // 2. Reserve the startup view: anything opened from now on wins over it.
  const commitInitial = nav.reserveInitial();

  // 3. Runtime opens (hot-start file association, "Open With", CLI events) and menus.
  await Promise.all([
    appWindow.listen<string>("open-folder", (event) => {
      void openFolderPath(event.payload);
    }),
    appWindow.listen<string>("open-file", (event) => {
      // The backend routes this to the frontmost window only. Reusing it would
      // discard whatever that window holds, so by default hand the document to
      // a new window — unless this one is empty, where spawning would just
      // leave an empty window behind.
      if (finderOpenPref === "new-window" && windowInUse()) {
        void invoke("open_new_window", { path: event.payload }).catch((e) => {
          console.warn("Failed to open a new window, reusing this one:", e);
          void openFileFromPath(event.payload);
        });
        return;
      }
      void openFileFromPath(event.payload);
    }),
    appWindow.listen("menu-open-folder", () => openFolder()),
    appWindow.listen("menu-open-file", () => openFile()),
    appWindow.listen("menu-open-folder-new-window", () => openFolderInNewWindow()),
    appWindow.listen("menu-print", () => printDocument()),
    appWindow.listen("menu-export-pdf", () => exportPdf()),
    appWindow.listen("menu-toggle-theme", () => toggleTheme()),
    appWindow.listen<RecentEntry>("menu-open-recent", (event) => openRecent(event.payload)),
    appWindow.listen("menu-clear-recent", () => clearRecents()),
    appWindow.listen("menu-open-preferences", () => openPrefs()),
    appWindow.listen("menu-find", () => focusSearch()),
    appWindow.listen<string>("menu-nav", (event) => handleNavCommand(event.payload)),
    getCurrentWebview().onDragDropEvent((event) => {
      document.body.classList.toggle("drag-over", event.payload.type === "over" || event.payload.type === "enter");
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        void openDroppedPath(event.payload.paths[0]);
      }
    }),
  ]);

  // 4. The rest of the window.
  await initLocale();
  await initTheme();
  initSearch();
  initPreferences();
  initChrome();

  // Populate the native "Open Recent" submenu from the persisted list.
  await syncRecentMenu(await loadRecents());

  // 5. The startup view. Pull anything the backend buffered for *this* window:
  // a CLI arg, a RunEvent::Opened that fired before our listener was
  // registered, or the folder handed to a window spawned from the File menu.
  const pending = await invoke<PendingOpen | null>("get_pending_open");
  const view = resolveInitialView(pending, await loadRootPath(), launchPref === "last-folder");
  let target: NavEntry = { kind: "home", rootPath: null, dir: [] };
  let savedStatus = "dir";
  if (view.kind === "file") {
    const sep = view.path.lastIndexOf("/");
    target = docEntry(view.path.substring(0, sep), view.path.substring(sep + 1));
  } else if (view.kind === "folder") {
    // The last folder may be gone since (deleted, unmounted volume): then home.
    // "denied" or "error" still opens it: the folder view says what is wrong.
    const fromSaved = pending?.kind !== "folder";
    savedStatus = fromSaved ? await pathStatus(view.path) : "dir";
    if (savedStatus !== "missing" && savedStatus !== "file" && savedStatus !== "other") {
      target = { kind: "folder", rootPath: view.path, dir: [] };
    }
  }
  const ok = await commitInitial(target);
  if (ok && target.kind === "doc" && target.rootPath) {
    await saveRootPath(target.rootPath);
    await recordRecent(`${target.rootPath}/${target.file}`, "file");
  }
  // A folder that cannot be read is shown (its view says why) but not promoted.
  if (
    ok &&
    target.kind === "folder" &&
    target.rootPath &&
    savedStatus === "dir" &&
    committedListing?.status === "ok"
  ) {
    await saveRootPath(target.rootPath);
    await recordRecent(target.rootPath, "folder");
  }
  // A startup view that failed falls back to home in onNavigationError; one
  // overtaken by an open that then failed too lands there the same way.
}

/** A window holds something the reader may want to keep: a folder, or an open in progress. */
function windowInUse(): boolean {
  return rootPath !== null || nav.pending() > 0;
}

async function openFolder(): Promise<void> {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected === "string") {
    await openFolderPath(selected);
  }
}

async function openFile(): Promise<void> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: MARKDOWN_EXTENSIONS }],
  });
  if (typeof selected === "string") {
    await openFileFromPath(selected);
  }
}

function openRecent(entry: RecentEntry): void {
  if (entry.kind === "file") {
    void openFileFromPath(entry.path);
  } else {
    void openFolderPath(entry.path);
  }
}

async function openDroppedPath(path: string): Promise<void> {
  const status = await invoke<string>("path_status", { path }).catch(() => "error");
  if (status === "dir") {
    await openFolderPath(path);
  } else if (status === "file" && isMarkdownName(path)) {
    await openFileFromPath(path);
  }
}

// The picker has to run here (dialog plugin is frontend-side); Rust then spawns
// the window and hands it the folder through its own pending-open slot, so this
// window's state is left untouched.
async function openFolderInNewWindow(): Promise<void> {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected !== "string") return;
  try {
    await invoke("open_new_window", { path: selected });
  } catch (e) {
    console.error("Failed to open a new window:", e);
  }
}

// --- Navigation commands ---

function goHome(): void {
  void nav.navigate({ kind: "home", rootPath, dir: [] });
}

function closeFolder(): void {
  const closed = rootPath;
  void nav.navigate({ kind: "home", rootPath: null, dir: [] }).then((ok) => {
    // A folder closed on purpose is not reopened at the next launch.
    if (ok && closed) void forgetRootPath(closed).catch((e) => console.warn("Could not forget the folder:", e));
    // The control that closed it (banner, folder menu) is gone: land on Home.
    const focused = document.activeElement as HTMLElement | null;
    if (ok && (!focused || focused === document.body || focused.getClientRects().length === 0)) {
      navHomeBtn.focus();
    }
  });
}

/** ⌘↑: from a document to its folder, from a folder to its parent. */
function goUp(): void {
  if (rootPath === null) return;
  const screen = activeScreen();
  if (screen === "doc") {
    void nav.navigate({ kind: "folder", rootPath, dir: [...currentPath] });
  } else if (screen === "folder" && currentPath.length > 0) {
    void nav.navigate({ kind: "folder", rootPath, dir: currentPath.slice(0, -1) });
  }
}

function handleNavCommand(step: string): void {
  if (modalOpen()) return;
  if (step === "back") void nav.back();
  else if (step === "forward") void nav.forward();
  else if (step === "home") goHome();
  else if (step === "up") goUp();
  else if (step === "close_folder") closeFolder();
}

/** Preferences, a theme dialog, a lightbox or a diagram is in front: leave the page alone. */
function modalOpen(): boolean {
  return Boolean(document.querySelector(".prefs-backdrop.visible, .image-overlay, .mermaid-overlay"));
}

// --- Filesystem ---

async function listDirectory(root: string, dir: string[]): Promise<Listing> {
  try {
    return summarizeListing(await readDir(getFullPath(root, dir)));
  } catch (e) {
    return { status: listingStatusFromError(e), rawCount: 0, entries: [] };
  }
}

// One listing per folder visit, shared by the sidebar, the folder view and the
// README lookup. Moving between documents of the same folder reuses it, so a
// cloud-synced folder is not listed again on every click.
let listingCache: { key: string; listing: Listing } | null = null;

async function listForNavigation(root: string, dir: string[], fresh: boolean): Promise<Listing> {
  const key = getFullPath(root, dir);
  if (!fresh && listingCache?.key === key && listingCache.listing.status === "ok") {
    return listingCache.listing;
  }
  const listing = await listDirectory(root, dir);
  listingCache = { key, listing };
  return listing;
}

/** How long the home screen waits on a path's status (network volumes can hang). */
const PATH_STATUS_TIMEOUT = 800;

/** "unknown" when the volume took too long to answer. */
async function pathStatus(path: string, timeoutMs?: number): Promise<string> {
  const status = invoke<string>("path_status", { path }).catch(() => "error");
  if (timeoutMs === undefined) return status;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), timeoutMs);
  });
  try {
    return await Promise.race([status, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Navigator ---

type Prepared =
  | { kind: "home"; home: HomeData }
  | { kind: "folder"; listing: Listing; readme: string | null }
  | { kind: "same-doc" }
  | {
      kind: "doc";
      html: string;
      fullPath: string;
      slow: boolean;
      listing: Listing;
      readme: string | null;
      timings: DocTimings;
    };

interface DocTimings {
  start: number;
  ping: number;
  read: number;
  parse: number;
  images?: number;
  dom?: number;
  outline?: number;
}

type Built =
  | { kind: "home"; node: HTMLElement }
  | { kind: "folder"; node: HTMLElement; sidebar: HTMLElement; count: number; listing: Listing }
  | { kind: "same-doc" }
  | {
      kind: "doc";
      node: DocumentFragment;
      sidebar: HTMLElement;
      count: number;
      listing: Listing;
      title: string;
      slow: boolean;
      timings: DocTimings;
    };

type Screen = "home" | "folder" | "doc";

function activeScreen(): Screen {
  return (document.body.dataset.screen as Screen) ?? "home";
}

let currentDocTitle = "";

async function buildHomeData(keptRoot: string | null): Promise<HomeData> {
  const [recents, lastRead] = await Promise.all([loadRecents(), loadLastRead()]);
  // Both checks at once, and bounded: the home screen must not wait on a slow
  // volume. A path that did not answer in time is offered as is; opening it
  // reports the failure if there is one.
  const [resumeStatus, keptStatus] = await Promise.all([
    lastRead ? pathStatus(`${lastRead.rootPath}/${lastRead.file}`, PATH_STATUS_TIMEOUT) : null,
    keptRoot ? pathStatus(keptRoot, PATH_STATUS_TIMEOUT) : null,
  ]);
  let resume: HomeData["resume"] = null;
  if (lastRead) {
    const status = resumeStatus;
    resume = {
      title: lastRead.title,
      file: lastRead.file,
      rootName: extractRootName(lastRead.rootPath),
      status:
        status === "file" || status === "unknown"
          ? "ok"
          : status === "denied" || status === "error"
            ? "denied"
            : "missing",
    };
  }
  let kept: HomeData["kept"] = null;
  if (keptRoot) {
    kept = { name: extractRootName(keptRoot), accessible: keptStatus === "dir" || keptStatus === "unknown" };
  }
  return { firstRun: recents.length === 0 && !lastRead, kept, resume, recents };
}

async function prepare(target: NavEntry, _stale: () => boolean, options: { reload: boolean }): Promise<Prepared> {
  if (target.kind === "home") {
    return { kind: "home", home: await buildHomeData(target.rootPath) };
  }
  const root = target.rootPath!;
  if (target.kind === "folder") {
    const loading = showLoadingSoon();
    try {
      const listing = await listForNavigation(root, target.dir, true);
      return { kind: "folder", listing, readme: findReadme(listing.entries)?.name ?? null };
    } finally {
      hideLoading(loading);
    }
  }
  // Same document, another heading: no need to read or render it again.
  if (!options.reload && activeScreen() === "doc" && root === rootPath && target.file === activeFile) {
    return { kind: "same-doc" };
  }
  const fullPath = `${root}/${target.file}`;
  const loading = showLoadingSoon();
  try {
    const t0 = performance.now();
    if (debugOverlay.isVisible()) await invoke("ping");
    const t1 = performance.now();
    const [{ text, slow }, listing] = await Promise.all([
      readDocumentText(fullPath, root),
      listForNavigation(root, target.dir, options.reload),
    ]);
    const t2 = performance.now();
    const html = parseMarkdown(text);
    const t3 = performance.now();
    return {
      kind: "doc",
      html,
      fullPath,
      slow,
      listing,
      readme: findReadme(listing.entries)?.name ?? null,
      timings: { start: t0, ping: t1 - t0, read: t2 - t1, parse: t3 - t2 },
    };
  } finally {
    hideLoading(loading);
  }
}

const fileCount = (listing: Listing) => listing.entries.filter((e) => e.kind === "file").length;

/** Open an entry listed in `dir` of the folder `root`: its folder view, or the document. */
function openEntry(root: string, dir: string[], entry: Entry): void {
  const path = [...dir, entry.name];
  if (entry.kind === "directory") void nav.navigate({ kind: "folder", rootPath: root, dir: path });
  else void openDocument(root, path.join("/"));
}

/** The sidebar for a folder of the open root. */
function sidebarNode(root: string, dir: string[], listing: Listing, activeName: string | null, readme: string | null) {
  return buildFileList(listing, dir.length > 0, activeName, findReadmeName(listing, readme), {
    open: (entry) => openEntry(root, dir, entry),
    up: () => void nav.navigate({ kind: "folder", rootPath: root, dir: dir.slice(0, -1) }),
  });
}

function findReadmeName(listing: Listing, readme: string | null): string | null {
  return readme ?? findReadme(listing.entries)?.name ?? null;
}

function folderViewNode(root: string, dir: string[], listing: Listing, knownReadme: string | null): HTMLElement {
  const readme = findReadmeName(listing, knownReadme);
  const readmePath = readme ? [...dir, readme].join("/") : null;
  return buildFolderView(
    { rootName: extractRootName(root), dir, listing, readme },
    {
      open: (entry) => openEntry(root, dir, entry),
      openReadme: () => {
        if (readmePath) void openDocument(root, readmePath);
      },
      openOther: () => void openFolder(),
    }
  );
}

function build(p: Prepared, ctx: CommitContext): Built {
  const target = ctx.target;
  if (p.kind === "home") {
    homeDataKey = JSON.stringify(p.home);
    return {
      kind: "home",
      node: buildHome(p.home, {
        resume: () => void resumeReading(),
        openFolder: () => void openFolder(),
        openFile: () => void openFile(),
        openExamples: () => void openExamples(),
        openRecent,
        clearRecents: () => void clearRecents(),
        returnToFolder: () => {
          if (target.rootPath) void nav.navigate(returnTarget(nav.state(), target.rootPath));
        },
        closeFolder,
        openResumeFolder: () => void openResumeFolder(),
      }),
    };
  }
  if (p.kind === "same-doc") return { kind: "same-doc" };

  const root = target.rootPath!;

  if (p.kind === "folder") {
    return {
      kind: "folder",
      node: folderViewNode(root, target.dir, p.listing, p.readme),
      sidebar: sidebarNode(root, target.dir, p.listing, null, p.readme),
      count: fileCount(p.listing),
      listing: p.listing,
    };
  }

  const container = document.createElement("div");
  container.innerHTML = p.html;
  const tImages = performance.now();
  resolveImagePaths(container, p.fullPath);
  p.timings.images = performance.now() - tImages;
  addCopyButtons(container);
  addImageLightbox(container, openImageOverlay);
  interceptLinks(container, root, target.dir);
  const fileName = target.file!.split("/").pop()!;
  const title = container.querySelector("h1")?.textContent?.trim() || fileName;
  // Moved off-page here so publishing is a single append, whatever the size
  // (spreading the children into one call overflows on huge documents).
  const content = document.createDocumentFragment();
  while (container.firstChild) content.append(container.firstChild);
  return {
    kind: "doc",
    node: content,
    sidebar: sidebarNode(root, target.dir, p.listing, fileName, p.readme),
    count: fileCount(p.listing),
    listing: p.listing,
    title,
    slow: p.slow,
    timings: p.timings,
  };
}

function publish(b: Built, ctx: CommitContext): void {
  try {
    publishView(b, ctx);
  } catch (e) {
    // The swap must not leave the window half-updated; report and keep going.
    console.error("Failed to publish the view:", e);
  }
  syncNavButtons();
}

// What the last commit put on screen, for the decorations that follow it.
let lastCommit: { sameDoc: boolean; timings: DocTimings | null; at: number } = {
  sameDoc: false,
  timings: null,
  at: 0,
};
// Bumped on every commit: an async home refresh only lands on the view it started from.
let viewToken = 0;
// The listing the sidebar on screen was built from (never a superseded one).
let committedListing: Listing | null = null;

function publishView(b: Built, ctx: CommitContext): void {
  const target = ctx.target;
  viewToken += 1;
  closeTransientUI();
  hideLoadError();
  // Whatever was still loading has been superseded by this commit.
  endLoadingIndicator();
  lastCommit = {
    sameDoc: b.kind === "same-doc",
    timings: b.kind === "doc" ? b.timings : lastCommit.timings,
    at: b.kind === "same-doc" ? lastCommit.at : Date.now(),
  };
  if (b.kind === "same-doc") return;

  rootPath = target.rootPath;
  rootName = rootPath ? extractRootName(rootPath) : "";
  currentPath = [...target.dir];
  activeFile = target.kind === "doc" ? target.file! : null;
  document.body.dataset.screen = target.kind;
  document.body.classList.toggle("has-folder", rootPath !== null);

  homeEl.hidden = b.kind !== "home";
  folderViewEl.hidden = b.kind !== "folder";
  docCard.hidden = b.kind !== "doc";

  if (b.kind === "home") {
    homeEl.replaceChildren(b.node);
    homeEl.scrollTop = 0;
  } else {
    committedListing = b.listing;
    folderSwitcherName.textContent = rootName;
    folderSwitcherPath.textContent = rootPath ? parentLabel(rootPath) : "";
    folderSwitcher.title = rootPath ?? "";
    sidebarCount.textContent = String(b.count);
    fileList.replaceChildren(b.sidebar);
  }

  if (b.kind === "folder") {
    folderViewEl.replaceChildren(b.node);
  }

  if (b.kind === "doc") {
    docDecorated = false;
    currentDocTitle = b.title;
    const tDom = performance.now();
    markdownEl.replaceChildren(b.node);
    slowReadNotice.hidden = !(b.slow && !slowReadDismissed);
    const tOutline = performance.now();
    buildOutline();
    b.timings.dom = tOutline - tDom;
    b.timings.outline = performance.now() - tOutline;
    // The search index points into the content just replaced: drop it until
    // the decorations (Mermaid) are done, then rebuild it. The query stays.
    searchController?.suspend();
    setSearchEnabled(false);
  } else {
    currentDocTitle = "";
    markdownEl.replaceChildren();
    if (scrollObserver) scrollObserver.disconnect();
    searchController?.suspend();
    setSearchEnabled(false);
  }

  breadcrumb.replaceChildren(
    rootPath && b.kind !== "home"
      ? buildBreadcrumb(rootName, currentPath, activeFile ? activeFile.split("/").pop()! : null, b.kind === "folder", (depth) => {
          void nav.navigate({ kind: "folder", rootPath: rootPath!, dir: currentPath.slice(0, depth) });
        })
      : document.createDocumentFragment()
  );
  const docShown = b.kind === "doc";
  printBtn.disabled = !docShown;
  pdfBtn.disabled = !docShown;
  syncWindowTitle();
}

// False from a document's commit until its decorations are done. A heading jump
// committed in between takes over the unfinished work instead of skipping it.
let docDecorated = true;

async function decorate(ctx: DecorationContext): Promise<void> {
  const screen = ctx.target.kind;
  if (screen === "doc" && lastCommit.sameDoc) {
    // A heading of the document already on screen: go there now.
    applyPositioning(contentEl, ctx.positioning);
    if (docDecorated) return;
    // The previous view's decorations were cut short: finish them, then
    // settle the position again (diagrams change the page's height) unless
    // the reader has scrolled meanwhile.
  }
  if (screen === "doc") {
    // Fresh document: put the reader in place right away (not at the previous
    // document's offset); the position is settled again once diagrams and
    // images have their final height, unless the reader scrolled meanwhile.
    if (!lastCommit.sameDoc) applyPositioning(contentEl, ctx.positioning);
    const timings = lastCommit.timings;
    const tMermaid = performance.now();
    try {
      await renderMermaidDiagrams(ctx.isCurrent);
    } catch (e) {
      console.warn("Diagrams failed to render:", e);
    }
    if (!ctx.isCurrent()) return;
    const mermaidMs = performance.now() - tMermaid;
    // A restored position (and a heading below images) is only right once
    // images have their real height.
    if (ctx.positioning.mode !== "top") await imagesSettled(markdownEl, 1500);
    if (!ctx.isCurrent()) return;
    if (!userScrolledSincePositioning) applyPositioning(contentEl, ctx.positioning);
    setSearchEnabled(true);
    searchController?.reset({
      scroll: !lastCommit.sameDoc && !ctx.traversal && ctx.positioning.mode === "top",
    });
    if (timings) {
      debugOverlay.recordOpen({
        file: ctx.target.file?.split("/").pop() ?? "",
        total: performance.now() - timings.start,
        phases: {
          ping: timings.ping,
          read: timings.read,
          parse: timings.parse,
          images: timings.images ?? 0,
          mermaid: mermaidMs,
          dom: timings.dom ?? 0,
          outline: timings.outline ?? 0,
        },
      });
    }
    docDecorated = true;
    if (rootPath && activeFile) {
      // Dated when the document was opened, not when its diagrams finished.
      void writeLastRead({
        rootPath,
        file: activeFile,
        title: currentDocTitle,
        scrollTop: contentEl.scrollTop,
        at: lastCommit.at,
      });
    }
    return;
  }
  const scroller = screen === "home" ? homeEl : folderViewEl;
  applyPositioning(scroller, ctx.positioning);
}

// Scrolls done by the app (restoring a position, jumping to a heading) must not
// count as reading activity; only the reader's own scrolling updates "lastRead".
let programmaticScroll = false;
let programmaticTimer: ReturnType<typeof setTimeout> | null = null;

/** Scrolls about to happen are the app's doing; `scrollend` (or a timer) ends the window. */
function markProgrammaticScroll(ms = 400): void {
  programmaticScroll = true;
  if (programmaticTimer !== null) clearTimeout(programmaticTimer);
  programmaticTimer = setTimeout(() => {
    programmaticScroll = false;
  }, ms);
}

// Set when the reader scrolls after the app positioned the page; a late
// re-positioning (diagrams finished) must then leave them alone.
let userScrolledSincePositioning = false;

function applyPositioning(scroller: HTMLElement, positioning: Positioning): void {
  userScrolledSincePositioning = false;
  markProgrammaticScroll();
  const before = scroller.scrollTop;
  if (positioning.mode === "anchor") {
    // A link to a heading that does not exist leaves the reader where they are.
    markdownEl.querySelector(`#${CSS.escape(positioning.anchor)}`)?.scrollIntoView({ block: "start" });
  } else if (positioning.mode === "restore") {
    scroller.scrollTop = positioning.scrollTop;
  } else {
    scroller.scrollTop = 0;
  }
  // Already in place: no scroll event will close the window, so close it now
  // and the reader's next scroll counts as theirs.
  if (scroller.scrollTop === before) endProgrammaticScroll();
}

function endProgrammaticScroll(): void {
  programmaticScroll = false;
  if (programmaticTimer !== null) clearTimeout(programmaticTimer);
  programmaticTimer = null;
}

contentEl.addEventListener("scrollend", endProgrammaticScroll);

// The reader's own input: whatever scroll follows is theirs, even inside the
// window the app opened for its own scrolls.
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
for (const type of ["wheel", "touchstart", "pointerdown"] as const) {
  contentEl.addEventListener(type, endProgrammaticScroll, { passive: true });
}
document.addEventListener("keydown", (e) => {
  if (SCROLL_KEYS.has(e.key) && activeScreen() === "doc") endProgrammaticScroll();
});

contentEl.addEventListener("scroll", () => {
  if (programmaticScroll) return;
  userScrolledSincePositioning = true;
  if (activeScreen() !== "doc" || !rootPath || !activeFile) return;
  scheduleLastRead({
    rootPath,
    file: activeFile,
    title: currentDocTitle,
    scrollTop: contentEl.scrollTop,
    at: Date.now(),
  });
});

/** Resolves once the images of `root` have loaded (or failed), or after `timeoutMs`. */
function imagesSettled(root: HTMLElement, timeoutMs: number): Promise<void> {
  const pending = Array.from(root.querySelectorAll("img")).filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  const loads = pending.map(
    (img) =>
      new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      })
  );
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function captureScroll(): number {
  const screen = activeScreen();
  if (screen === "doc") return contentEl.scrollTop;
  if (screen === "folder") return folderViewEl.scrollTop;
  return homeEl.scrollTop;
}

function onNavigationError(error: unknown, target: NavEntry): void {
  console.error("Failed to open:", target, error);
  showLoadError(target);
  // Nothing on screen yet (a startup open that failed, wherever it came from):
  // show home so the window stays usable. Checked once the navigator has let
  // go of the failed navigation; another one still loading takes over instead.
  if (target.kind !== "home") {
    queueMicrotask(() => {
      if (nav.state().current || nav.pending() > 0) return;
      void nav.navigate({ kind: "home", rootPath: null, dir: [] }).then((shown) => {
        // The home commit cleared the banner: tell the reader why they are here.
        if (shown) showLoadError(target);
      });
    });
  }
}

function showLoadError(target: NavEntry): void {
  // Surface the failure. A console-only error made a whole class of unopenable
  // files look like an unresponsive click: the sidebar listed them, selecting
  // one simply did nothing.
  const name = target.file?.split("/").pop() ?? target.rootPath ?? "";
  loadErrorText.textContent = t("loadError.message").replace("{file}", name);
  loadError.hidden = false;
  if (activeScreen() !== "doc") {
    // The banner lives in the document card; on other screens show it on top.
    document.body.classList.add("show-load-error");
    if (loadErrorTimer !== null) clearTimeout(loadErrorTimer);
    loadErrorTimer = setTimeout(hideLoadError, 5000);
  }
}

let loadErrorTimer: ReturnType<typeof setTimeout> | null = null;

function hideLoadError(): void {
  if (loadErrorTimer !== null) clearTimeout(loadErrorTimer);
  loadErrorTimer = null;
  loadError.hidden = true;
  document.body.classList.remove("show-load-error");
}

const nav: WindowNavigator = createNavigator<Prepared, Built>({
  prepare,
  build,
  publish,
  captureScroll,
  decorate,
  onError: onNavigationError,
});

function syncNavButtons(): void {
  const state = nav.state();
  navBackBtn.disabled = !state.canBack;
  navForwardBtn.disabled = !state.canForward;
  const home = state.current?.kind === "home";
  navHomeBtn.classList.toggle("is-current", home);
  if (home) navHomeBtn.setAttribute("aria-current", "page");
  else navHomeBtn.removeAttribute("aria-current");
  syncNavMenu(state.current, state.canBack, state.canForward);
}

let navMenuKey = "";

/** The Go menu is app-wide: tell it what this window can do; it shows the frontmost window's. */
function syncNavMenu(current: NavEntry | null, canBack: boolean, canForward: boolean): void {
  const inFolder = current !== null && current.rootPath !== null;
  const menuState = {
    back: canBack,
    forward: canForward,
    home: current?.kind !== "home",
    up: inFolder && (current.kind === "doc" || (current.kind === "folder" && current.dir.length > 0)),
    closeFolder: inFolder,
  };
  const key = JSON.stringify(menuState);
  if (key === navMenuKey) return;
  navMenuKey = key;
  void invoke("set_nav_menu_state", { state: menuState }).catch((e) => console.warn("Go menu not updated:", e));
}

// Data the home screen on display was built from: refreshing only when it
// changed keeps a click that activates the window from landing on a node that
// is being replaced.
let homeDataKey = "";
let homeRefreshSeq = 0;

async function refreshHome(): Promise<void> {
  const current = nav.state().current;
  if (current?.kind !== "home") return;
  const token = viewToken;
  const seq = ++homeRefreshSeq;
  const data = await buildHomeData(current.rootPath);
  // Another view was committed meanwhile (closing the folder, opening one…),
  // or a later refresh started: only the latest lands.
  if (token !== viewToken || seq !== homeRefreshSeq) return;
  const key = JSON.stringify(data);
  if (key === homeDataKey) return;
  homeDataKey = key;
  if (nav.state().current !== null && activeScreen() === "home") {
    const ctx: CommitContext = { target: current, positioning: { mode: "top" }, traversal: false, viewGen: 0 };
    const built = build({ kind: "home", home: data }, ctx);
    if (built.kind === "home") homeEl.replaceChildren(built.node);
  }
}

/**
 * Rebuild what is built in JS in the current language, without navigating
 * (a load under way is left alone) and without reading anything again.
 */
function relabelScreen(): void {
  const current = nav.state().current;
  if (!current) return;
  if (current.kind === "home") {
    homeDataKey = "";
    void refreshHome();
    return;
  }
  if (!rootPath || !committedListing) return;
  const root = rootPath;
  const dir = [...currentPath];
  const activeName = activeFile?.split("/").pop() ?? null;
  fileList.replaceChildren(sidebarNode(root, dir, committedListing, activeName, null));
  breadcrumb.replaceChildren(
    buildBreadcrumb(rootName, dir, activeName, current.kind === "folder", (depth) => {
      void nav.navigate({ kind: "folder", rootPath: root, dir: dir.slice(0, depth) });
    })
  );
  if (current.kind === "folder") {
    folderViewEl.replaceChildren(folderViewNode(root, dir, committedListing, null));
    return;
  }
  for (const btn of markdownEl.querySelectorAll<HTMLButtonElement>(".copy-btn:not(.copied)")) {
    btn.textContent = t("code.copy");
  }
  for (const btn of markdownEl.querySelectorAll<HTMLButtonElement>(".mermaid-fullscreen-btn")) {
    btn.textContent = t("mermaid.fullscreen");
  }
  for (const msg of markdownEl.querySelectorAll<HTMLElement>(".mermaid-error-msg")) {
    msg.textContent = t("mermaid.error");
  }
}

async function resumeReading(): Promise<void> {
  const lastRead = await loadLastRead();
  if (!lastRead) return;
  await nav.navigate(docEntry(lastRead.rootPath, lastRead.file), {
    restoreScrollTop: lastRead.scrollTop,
  });
}

async function openResumeFolder(): Promise<void> {
  const lastRead = await loadLastRead();
  if (lastRead) await openFolderPath(lastRead.rootPath);
}

// --- File loading ---

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

// Reads are slow on cloud-synced folders (OneDrive/iCloud materialize
// "online-only" files on first access). Cache by path+mtime so re-opening a
// document is instant, and surface a one-time notice when a real read is slow.
const SLOW_READ_MS = 600;
const docCache = new Map<string, { mtime: number; text: string }>();
let slowReadDismissed = false;
let loadingTimer: ReturnType<typeof setTimeout> | null = null;

// Loads overlap when a newer one supersedes an older one: the indicator
// follows the latest only, so a slow superseded read cannot keep it spinning.
let loadToken = 0;

function showLoadingSoon(): number {
  loadToken += 1;
  if (loadingTimer !== null) clearTimeout(loadingTimer);
  // Small delay so instant (cached) reads never flash a spinner.
  loadingTimer = setTimeout(() => {
    contentLoading.hidden = false;
    // The card may be hidden (opening from home or a folder): show it up top too.
    navSpinner.hidden = false;
    srStatus.textContent = t("loading");
  }, 150);
  return loadToken;
}

/** Stop the loading indicator whatever load it belonged to. */
function endLoadingIndicator(): void {
  loadToken += 1;
  hideLoading(loadToken);
}

function hideLoading(token: number): void {
  if (token !== loadToken) return;
  if (loadingTimer !== null) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }
  contentLoading.hidden = true;
  navSpinner.hidden = true;
  srStatus.textContent = "";
}

slowReadDismiss.addEventListener("click", () => {
  slowReadNotice.hidden = true;
  slowReadDismissed = true;
});

// `root` is captured by the navigation that asked for this read, so a slow read
// started for one folder can never be resolved against another.
async function readDocumentText(
  fullPath: string,
  root: string
): Promise<{ text: string; slow: boolean }> {
  let mtime: number | null = null;
  try {
    mtime = await invoke<number>("document_mtime", { path: fullPath });
  } catch {
    mtime = null;
  }
  const cached = docCache.get(fullPath);
  if (cached && mtime !== null && cached.mtime === mtime) {
    return { text: cached.text, slow: false };
  }
  const start = performance.now();
  // `root` is the access the user granted by opening this folder; the backend
  // refuses anything outside it.
  const text = await invoke<string>("read_document", {
    path: fullPath,
    root,
  });
  const slow = performance.now() - start >= SLOW_READ_MS;
  if (mtime !== null) {
    docCache.set(fullPath, { mtime, text });
  }
  return { text, slow };
}

// --- Right outline ---

function buildOutline(): void {
  if (scrollObserver) scrollObserver.disconnect();

  const headings = markdownEl.querySelectorAll("h2, h3");
  outlineNav.replaceChildren();

  if (headings.length === 0) {
    outlineEl.style.display = "none";
    document.body.classList.remove("has-outline");
    return;
  }

  outlineEl.style.display = "";
  document.body.classList.add("has-outline");
  const items: { el: HTMLButtonElement; heading: Element }[] = [];

  for (const h of headings) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "outline-item";
    if (h.tagName === "H3") item.classList.add("depth-3");
    item.textContent = h.textContent;
    item.dataset.targetId = h.id;
    item.addEventListener("click", () => {
      userScrolledSincePositioning = true;
      markProgrammaticScroll(1500);
      h.scrollIntoView({ behavior: "smooth" });
      if (document.body.classList.contains("outline-open")) {
        setOutlineOpen(false);
        outlineToggle.focus();
      }
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
            const active = i.heading.id === id;
            i.el.classList.toggle("active", active);
            if (active) i.el.setAttribute("aria-current", "location");
            else i.el.removeAttribute("aria-current");
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

/** A heading of the open document; following the same link again scrolls again. */
function goToAnchor(root: string, file: string, anchor: string): void {
  if (nav.state().current?.anchor === anchor) {
    // The reader chose to stay here: whatever was still loading is dropped.
    nav.cancelPending();
    endLoadingIndicator();
    userScrolledSincePositioning = true;
    markProgrammaticScroll(1500);
    markdownEl.querySelector(`#${CSS.escape(anchor)}`)?.scrollIntoView({ behavior: "smooth" });
    return;
  }
  void nav.navigate(docEntry(root, file, anchor));
}

function interceptLinks(container: HTMLElement, root: string, currentDir: string[]): void {
  const file = () => activeFile;
  for (const a of container.querySelectorAll("a")) {
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
        const anchor = decodeAnchor(href.slice(1));
        const current = file();
        if (anchor && current) goToAnchor(root, current, anchor);
      });
      continue;
    }

    if (linkType === "markdown") {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const { filePart, anchor } = parseMarkdownHref(href);
        const resolved = resolvePath([...currentDir], filePart);
        if (anchor && resolved === file()) goToAnchor(root, resolved, anchor);
        else void nav.navigate(docEntry(root, resolved, anchor));
      });
    }
  }
}

init();
