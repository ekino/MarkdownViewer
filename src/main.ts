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

function applyActiveTheme(): void {
  const id = activeThemeId();
  applyThemeToDOM(themeCatalog, document.documentElement, id);
  const dark = themeCatalog[id]?.isDark ?? false;
  themeToggle.textContent = dark ? "\u2600\uFE0F" : "\u{1F319}";
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
const contentLoading = document.getElementById(
  "content-loading"
) as HTMLDivElement;
const slowReadNotice = document.getElementById(
  "slow-read-notice"
) as HTMLDivElement;
const slowReadDismiss = document.getElementById(
  "slow-read-dismiss"
) as HTMLButtonElement;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const examplesBtn = document.getElementById(
  "examples-btn"
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

const STORE_FILE = "settings.json";
const STORE_KEY = "lastFolder";

// --- Store persistence ---

async function saveRootPath(path: string): Promise<void> {
  const store = await load(STORE_FILE);
  await store.set(STORE_KEY, path);
  await store.save();
}

async function loadRootPath(): Promise<string | null> {
  const store = await load(STORE_FILE);
  return ((await store.get(STORE_KEY)) as string) ?? null;
}

// --- Init ---

openBtn.addEventListener("click", openFolder);
examplesBtn.addEventListener("click", openExamples);

async function openExamples(): Promise<void> {
  const examplesPath = await resolveResource("examples");
  await setRootPath(examplesPath);
}

type PendingOpen =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string };

async function openFileFromPath(filePath: string): Promise<void> {
  const lastSep = filePath.lastIndexOf("/");
  const parentDir = filePath.substring(0, lastSep);
  const fileName = filePath.substring(lastSep + 1);
  await setRootPath(parentDir, fileName);
}

// --- Debug HUD ---

const debugOverlay = createDebugOverlay();

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

function focusSearch(): void {
  if (searchInput.disabled) {
    return;
  }
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

  // Runtime opens (hot-start file association, "Open With", CLI events)
  appWindow.listen<string>("open-folder", (event) => {
    setRootPath(event.payload);
  });
  appWindow.listen<string>("open-file", (event) => {
    openFileFromPath(event.payload);
  });
  appWindow.listen("menu-open-folder", () => {
    openFolder();
  });
  appWindow.listen("menu-open-preferences", () => {
    openPrefs();
  });
  appWindow.listen("menu-find", () => {
    focusSearch();
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

  const saved = await loadRootPath();
  if (saved) {
    await setRootPath(saved);
  }
}

async function setRootPath(path: string, fileToOpen?: string): Promise<void> {
  rootPath = path;
  rootName = extractRootName(path);
  currentPath = [];
  activeFile = null;
  await saveRootPath(path);
  await renderSidebar();
  if (fileToOpen) {
    await loadFile(fileToOpen);
  } else {
    await autoSelectReadme();
  }
}

async function openFolder(): Promise<void> {
  const selected = await open({ directory: true, multiple: false });
  if (selected) {
    await setRootPath(selected);
  }
}

// --- Filesystem ---

async function listEntries(dirPath: string): Promise<Entry[]> {
  const entries = await readDir(dirPath);
  return filterAndSortEntries(entries);
}

// --- Sidebar ---

async function renderSidebar(): Promise<void> {
  const dirPath = getFullPath(rootPath!, currentPath);
  const entries = await listEntries(dirPath);
  fileList.innerHTML = "";

  emptyState.style.display = "none";
  markdownEl.style.display = activeFile ? "block" : "none";
  if (!activeFile) {
    emptyState.style.display = "block";
    contentEl.classList.add("empty");
    titlebarFilename.textContent = "";
    setSearchEnabled(false);
  }

  if (currentPath.length > 0) {
    const back = document.createElement("div");
    back.className = "file-item";
    const backIcon = document.createElement("span");
    backIcon.className = "icon";
    backIcon.textContent = "..";
    const backName = document.createElement("span");
    backName.className = "name";
    backName.textContent = t("sidebar.parent");
    back.append(backIcon, backName);
    back.addEventListener("click", () => {
      currentPath.pop();
      renderSidebar();
    });
    fileList.appendChild(back);
  }

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "file-item";
    const icon = entry.kind === "directory" ? "\u{1F4C1}" : "\u{1F4C4}";
    item.innerHTML = `<span class="icon">${icon}</span><span class="name">${entry.name}</span>`;

    if (entry.kind === "directory") {
      item.addEventListener("click", () => {
        currentPath.push(entry.name);
        renderSidebar();
      });
    } else {
      const filePath = [...currentPath, entry.name].join("/");
      if (filePath === activeFile) item.classList.add("active");
      item.addEventListener("click", () => loadFile(filePath));
    }
    fileList.appendChild(item);
  }
  renderBreadcrumb();
}

function renderBreadcrumb(): void {
  breadcrumb.innerHTML = "";

  const changeBtn = document.createElement("span");
  changeBtn.textContent = "\u21C4";
  changeBtn.title = t("breadcrumb.change");
  changeBtn.style.cssText =
    "cursor:pointer;font-size:14px;margin-right:4px;opacity:0.6;";
  changeBtn.addEventListener("click", openFolder);
  breadcrumb.appendChild(changeBtn);

  const root = document.createElement("span");
  root.textContent = rootName;
  if (currentPath.length > 0) {
    root.addEventListener("click", () => {
      currentPath = [];
      renderSidebar();
    });
  } else {
    root.classList.add("current");
  }
  breadcrumb.appendChild(root);

  currentPath.forEach((part, i) => {
    breadcrumb.appendChild(document.createTextNode(" / "));
    const span = document.createElement("span");
    span.textContent = part;
    if (i < currentPath.length - 1) {
      span.addEventListener("click", () => {
        currentPath = currentPath.slice(0, i + 1);
        renderSidebar();
      });
    } else {
      span.classList.add("current");
    }
    breadcrumb.appendChild(span);
  });
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

// Reads are slow on cloud-synced folders (OneDrive/iCloud materialize
// "online-only" files on first access). Cache by path+mtime so re-opening a
// document is instant, and surface a one-time notice when a real read is slow.
const SLOW_READ_MS = 600;
const docCache = new Map<string, { mtime: number; text: string }>();
let slowReadDismissed = false;
let loadingTimer: ReturnType<typeof setTimeout> | null = null;

function showLoadingSoon(): void {
  // Small delay so instant (cached) reads never flash a spinner.
  loadingTimer = setTimeout(() => {
    contentLoading.hidden = false;
  }, 150);
}

function hideLoading(): void {
  if (loadingTimer !== null) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }
  contentLoading.hidden = true;
}

slowReadDismiss.addEventListener("click", () => {
  slowReadNotice.hidden = true;
  slowReadDismissed = true;
});

async function readDocumentText(
  fullPath: string
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
  const text = await invoke<string>("read_document", { path: fullPath });
  const slow = performance.now() - start >= SLOW_READ_MS;
  if (mtime !== null) {
    docCache.set(fullPath, { mtime, text });
  }
  return { text, slow };
}

async function loadFile(filePath: string): Promise<void> {
  try {
    const fullPath = `${rootPath}/${filePath}`;
    // IPC round-trip probe — only when the debug HUD is open, so normal use
    // doesn't pay for an extra invoke on every document open.
    const tPing0 = performance.now();
    if (debugOverlay.isVisible()) {
      await invoke("ping");
    }
    const tPing1 = performance.now();

    showLoadingSoon();
    const tRead0 = performance.now();
    let text: string;
    let slowRead: boolean;
    try {
      ({ text, slow: slowRead } = await readDocumentText(fullPath));
    } finally {
      hideLoading();
    }
    const tRead1 = performance.now();

    slowReadNotice.hidden = !(slowRead && !slowReadDismissed);

    activeFile = filePath;
    emptyState.style.display = "none";
    markdownEl.style.display = "block";
    contentEl.classList.remove("empty");

    const t0 = performance.now();
    markdownEl.innerHTML = parseMarkdown(text);
    const t1 = performance.now();
    resolveImagePaths(markdownEl, fullPath);
    contentEl.scrollTop = 0;
    const t2 = performance.now();

    await renderMermaidDiagrams();
    const t3 = performance.now();
    addCopyButtons(markdownEl);
    addImageLightbox(markdownEl, openImageOverlay);
    const t4 = performance.now();

    const fileDir = filePath.split("/").slice(0, -1);
    if (fileDir.join("/") !== currentPath.join("/")) {
      currentPath = fileDir;
      await renderSidebar();
    }

    const currentDir = filePath.split("/").slice(0, -1);
    interceptLinks(currentDir);
    highlightSidebar();
    const t5 = performance.now();
    buildOutline();
    const t6 = performance.now();

    titlebarFilename.textContent = filePath.split("/").pop() ?? "";
    setSearchEnabled(true);
    searchController?.reset();

    debugOverlay.recordOpen({
      file: filePath.split("/").pop() ?? filePath,
      total: t6 - tPing0,
      phases: {
        ping: tPing1 - tPing0,
        read: tRead1 - tRead0,
        parse: t1 - t0,
        images: t2 - t1,
        mermaid: t3 - t2,
        dom: t4 - t3,
        outline: t6 - t5,
      },
    });
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

function highlightSidebar(): void {
  for (const item of fileList.querySelectorAll(".file-item")) {
    item.classList.remove("active");
  }
  if (!activeFile) return;
  const activeName = activeFile.split("/").pop();
  const activeDir = activeFile.split("/").slice(0, -1).join("/");
  if (activeDir === currentPath.join("/")) {
    for (const item of fileList.querySelectorAll(".file-item")) {
      if (item.querySelector(".name")?.textContent === activeName) {
        item.classList.add("active");
      }
    }
  }
}

init();
