import mermaid from "mermaid";
import "katex/dist/katex.min.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { load } from "@tauri-apps/plugin-store";
import { addCopyButtons, addImageLightbox } from "./dom";
import { parseMarkdown } from "./markdown";
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

// --- Theme management ---

const THEME_KEY = "theme";
const themeToggle = document.getElementById(
  "theme-toggle"
) as HTMLButtonElement;

function isDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

function applyTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeToggle.textContent = dark ? "\u2600\uFE0F" : "\u{1F319}";
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    securityLevel: "loose",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });
}

async function initTheme(): Promise<void> {
  const store = await load(STORE_FILE);
  const saved = (await store.get(THEME_KEY)) as string | null;
  if (saved) {
    applyTheme(saved === "dark");
  } else {
    applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
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
  const newDark = !isDark();
  applyTheme(newDark);
  const store = await load(STORE_FILE);
  await store.set(THEME_KEY, newDark ? "dark" : "light");
  await store.save();
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
      errMsg.textContent = "Mermaid syntax error — showing source";
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

  const fullImg = document.createElement("img");
  fullImg.src = img.src;
  fullImg.alt = img.alt;
  fullImg.className = "image-overlay-img";

  overlay.appendChild(fullImg);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add("visible"));

  function closeOverlay() {
    overlay.classList.remove("visible");
    document.removeEventListener("keydown", onKeyDown);
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

  const header = document.createElement("div");
  header.className = "mermaid-overlay-header";

  const titleEl = document.createElement("div");
  titleEl.className = "mermaid-overlay-title";
  titleEl.textContent = title;

  const closeBtn = document.createElement("button");
  closeBtn.className = "mermaid-overlay-close";
  closeBtn.textContent = "Close (Esc)";
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") closeOverlay();
  }
  document.addEventListener("keydown", onKeyDown);

  function closeOverlay() {
    overlay.classList.remove("visible");
    document.removeEventListener("keydown", onKeyDown);
    setTimeout(() => overlay.remove(), 200);
  }
}

const fileList = document.getElementById("file-list") as HTMLDivElement;
const breadcrumb = document.getElementById("breadcrumb") as HTMLDivElement;
const markdownEl = document.getElementById("markdown") as HTMLDivElement;
const emptyState = document.getElementById("empty-state") as HTMLDivElement;
const contentEl = document.getElementById("content") as HTMLDivElement;
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

async function init(): Promise<void> {
  await initTheme();
  initSearch();
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
    back.innerHTML =
      '<span class="icon">..</span><span class="name">Parent directory</span>';
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
  changeBtn.title = "Change folder";
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

async function loadFile(filePath: string): Promise<void> {
  try {
    const fullPath = `${rootPath}/${filePath}`;
    const text = await readTextFile(fullPath);

    activeFile = filePath;
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
      await renderSidebar();
    }

    const currentDir = filePath.split("/").slice(0, -1);
    interceptLinks(currentDir);
    highlightSidebar();
    buildOutline();

    titlebarFilename.textContent = filePath.split("/").pop() ?? "";
    setSearchEnabled(true);
    searchController?.reset();
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
