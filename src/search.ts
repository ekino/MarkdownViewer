export interface SearchOptions {
  caseSensitive: boolean;
  ignoreDiacritics: boolean;
  wholeWord: boolean;
}

export interface SearchState {
  current: number;
  total: number;
  capped: boolean;
}

export interface SearchUI {
  input: HTMLInputElement;
  counter: HTMLElement;
  onChange?: (state: SearchState) => void;
}

export interface SearchController {
  setQuery: (q: string) => void;
  next: () => void;
  prev: () => void;
  setOptions: (opts: Partial<SearchOptions>) => void;
  getOptions: () => SearchOptions;
  reset: () => void;
  clear: () => void;
  getState: () => SearchState;
  refocusCurrent: () => void;
}

interface NodeChunk {
  node: Text;
  rawStart: number;
  rawEnd: number;
}

interface SearchIndex {
  rawText: string;
  nodes: NodeChunk[];
  normText: string;
  offsetMap: Int32Array;
}

interface MatchRange {
  rawStart: number;
  rawEnd: number;
}

const MAX_HITS = 1000;
const DIACRITIC_RE = /\p{Diacritic}/gu;
const LETTER_OR_NUMBER_RE = /\p{L}|\p{N}/u;
const EXCLUDE_SELECTOR =
  ".katex, .mermaid-wrapper, .copy-btn, .mdv-search-hit, script, style";
const HIGHLIGHT_NAME = "mdv-search";
const HIGHLIGHT_CURRENT_NAME = "mdv-search-current";

const supportsCSSHighlights =
  typeof CSS !== "undefined" &&
  typeof (CSS as unknown as { highlights?: unknown }).highlights !==
    "undefined" &&
  typeof Highlight !== "undefined";

function debounce<T extends (...args: never[]) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (handle !== null) {
      clearTimeout(handle);
    }
    handle = setTimeout(() => {
      handle = null;
      fn(...args);
    }, ms);
  };
}

function isExcluded(node: Node): boolean {
  let el: Node | null = node.parentNode;
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    if ((el as Element).matches?.(EXCLUDE_SELECTOR)) {
      return true;
    }
    el = el.parentNode;
  }
  return false;
}

export function buildIndex(
  container: HTMLElement,
  opts: SearchOptions
): SearchIndex {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) {
        return NodeFilter.FILTER_REJECT;
      }
      if (isExcluded(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: NodeChunk[] = [];
  let raw = "";
  let n = walker.nextNode() as Text | null;
  while (n) {
    const value = n.nodeValue ?? "";
    if (value.length > 0) {
      const start = raw.length;
      raw += value;
      nodes.push({ node: n, rawStart: start, rawEnd: raw.length });
    }
    n = walker.nextNode() as Text | null;
  }

  const { normText, offsetMap } = normalizeWithMap(raw, opts);
  return { rawText: raw, nodes, normText, offsetMap };
}

export function normalizeWithMap(
  raw: string,
  opts: SearchOptions
): { normText: string; offsetMap: Int32Array } {
  let out = "";
  const offsets: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    let mapped = raw[i];
    if (opts.ignoreDiacritics) {
      mapped = mapped.normalize("NFD").replace(DIACRITIC_RE, "");
    }
    if (!opts.caseSensitive) {
      mapped = mapped.toLocaleLowerCase();
    }
    // Push one entry per UTF-16 code unit of `mapped` (not code point), so the
    // map aligns with `String.prototype.indexOf` results in `findMatches`.
    // biome-ignore lint/style/useForOf: counter loop, not iterating array
    for (let unit = 0; unit < mapped.length; unit++) {
      offsets.push(i);
    }
    out += mapped;
  }
  offsets.push(raw.length);
  return { normText: out, offsetMap: Int32Array.from(offsets) };
}

export function normalizeQuery(q: string, opts: SearchOptions): string {
  let s = q;
  if (opts.ignoreDiacritics) {
    s = s.normalize("NFD").replace(DIACRITIC_RE, "");
  }
  if (!opts.caseSensitive) {
    s = s.toLocaleLowerCase();
  }
  return s;
}

function isWordBoundary(text: string, pos: number): boolean {
  if (pos < 0 || pos >= text.length) {
    return true;
  }
  return !LETTER_OR_NUMBER_RE.test(text[pos]);
}

export function findMatches(
  index: SearchIndex,
  query: string,
  opts: SearchOptions
): MatchRange[] {
  if (!query) {
    return [];
  }
  const normQuery = normalizeQuery(query, opts);
  if (!normQuery) {
    return [];
  }

  const out: MatchRange[] = [];
  const text = index.normText;
  let from = 0;
  while (true) {
    const idx = text.indexOf(normQuery, from);
    if (idx === -1) {
      break;
    }
    const end = idx + normQuery.length;
    const accept =
      !opts.wholeWord ||
      (isWordBoundary(text, idx - 1) && isWordBoundary(text, end));
    if (accept) {
      const rawStart = index.offsetMap[idx];
      const rawEnd = index.offsetMap[end];
      out.push({ rawStart, rawEnd });
      if (out.length >= MAX_HITS) {
        break;
      }
    }
    from = idx + Math.max(1, normQuery.length);
  }
  return out;
}

function findChunk(nodes: NodeChunk[], rawIndex: number): NodeChunk | null {
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const c = nodes[mid];
    if (rawIndex < c.rawStart) {
      hi = mid - 1;
    } else if (rawIndex >= c.rawEnd) {
      lo = mid + 1;
    } else {
      return c;
    }
  }
  if (nodes.length > 0 && rawIndex >= 0) {
    const lastIdx = nodes.length - 1;
    const last = nodes[lastIdx];
    if (rawIndex === last.rawEnd) {
      return last;
    }
  }
  return null;
}

function rangeFromRaw(
  index: SearchIndex,
  rawStart: number,
  rawEnd: number
): Range | null {
  const startChunk = findChunk(index.nodes, rawStart);
  const endLookup = rawEnd === rawStart ? rawEnd : rawEnd - 1;
  const endChunk = findChunk(index.nodes, endLookup);
  if (!(startChunk && endChunk)) {
    return null;
  }
  const range = document.createRange();
  range.setStart(startChunk.node, rawStart - startChunk.rawStart);
  const endChunkForEnd = findChunk(index.nodes, rawEnd) ?? endChunk;
  const endOffset = rawEnd - endChunkForEnd.rawStart;
  const max = endChunkForEnd.node.nodeValue?.length ?? 0;
  range.setEnd(endChunkForEnd.node, Math.min(endOffset, max));
  return range;
}

interface CSSWithHighlights {
  highlights: Map<string, unknown>;
}

function applyCSSHighlights(ranges: Range[], currentIndex: number): void {
  const reg = (CSS as unknown as CSSWithHighlights).highlights;
  reg.delete(HIGHLIGHT_NAME);
  reg.delete(HIGHLIGHT_CURRENT_NAME);
  if (ranges.length === 0) {
    return;
  }
  const HighlightCtor = Highlight as unknown as new (...r: Range[]) => unknown;
  reg.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
  updateCSSCurrentHighlight(ranges, currentIndex);
}

function updateCSSCurrentHighlight(
  ranges: Range[],
  currentIndex: number
): void {
  const reg = (CSS as unknown as CSSWithHighlights).highlights;
  reg.delete(HIGHLIGHT_CURRENT_NAME);
  if (currentIndex >= 0 && ranges[currentIndex]) {
    const HighlightCtor = Highlight as unknown as new (
      ...r: Range[]
    ) => unknown;
    reg.set(HIGHLIGHT_CURRENT_NAME, new HighlightCtor(ranges[currentIndex]));
  }
}

function clearMarkFallback(container: HTMLElement): void {
  for (const m of container.querySelectorAll("mark.mdv-search-hit")) {
    const parent = m.parentNode;
    if (!parent) {
      continue;
    }
    while (m.firstChild) {
      parent.insertBefore(m.firstChild, m);
    }
    parent.removeChild(m);
    parent.normalize();
  }
}

function applyMarkFallback(ranges: Range[], currentIndex: number): void {
  // Wrap from last to first so earlier ranges remain valid as we mutate.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    const mark = document.createElement("mark");
    mark.className = "mdv-search-hit";
    if (i === currentIndex) {
      mark.classList.add("mdv-search-hit--active");
    }
    try {
      r.surroundContents(mark);
    } catch {
      // Range spans multiple elements: skip.
    }
  }
}

export function createSearchController(
  container: HTMLElement,
  ui: SearchUI,
  initialOptions?: Partial<SearchOptions>
): SearchController {
  let options: SearchOptions = {
    caseSensitive: false,
    ignoreDiacritics: true,
    wholeWord: false,
    ...initialOptions,
  };
  let index: SearchIndex | null = null;
  let query = "";
  let ranges: Range[] = [];
  let currentIndex = -1;
  let totalUncapped = 0;

  function ensureIndex(): SearchIndex {
    if (!index) {
      index = buildIndex(container, options);
    }
    return index;
  }

  function clearHighlights(): void {
    if (supportsCSSHighlights) {
      const reg = (CSS as unknown as CSSWithHighlights).highlights;
      reg.delete(HIGHLIGHT_NAME);
      reg.delete(HIGHLIGHT_CURRENT_NAME);
    } else {
      clearMarkFallback(container);
    }
  }

  function applyHighlights(): void {
    if (supportsCSSHighlights) {
      applyCSSHighlights(ranges, currentIndex);
      return;
    }
    clearMarkFallback(container);
    applyMarkFallback(ranges, currentIndex);
    // After DOM mutation the index is stale.
    index = null;
  }

  function refreshCurrent(): void {
    if (supportsCSSHighlights) {
      updateCSSCurrentHighlight(ranges, currentIndex);
      return;
    }
    // Fallback path: full re-apply (DOM is mutated either way).
    applyHighlights();
  }

  function getState(): SearchState {
    return {
      current: currentIndex,
      total: ranges.length,
      capped: totalUncapped >= MAX_HITS,
    };
  }

  function notify(): void {
    const state = getState();
    if (state.total === 0) {
      ui.counter.textContent = query ? "0/0" : "";
    } else {
      const cappedSuffix = state.capped ? "+" : "";
      ui.counter.textContent = `${state.current + 1}/${state.total}${cappedSuffix}`;
    }
    ui.onChange?.(state);
  }

  function scrollToCurrent(): void {
    if (currentIndex < 0 || !ranges[currentIndex]) {
      return;
    }
    const r = ranges[currentIndex];
    const startNode = r.startContainer;
    const el =
      startNode.nodeType === Node.ELEMENT_NODE
        ? (startNode as Element)
        : (startNode.parentElement as Element | null);
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }

  function recompute(): void {
    if (!supportsCSSHighlights) {
      clearHighlights();
    }
    const idx = ensureIndex();
    const matches = findMatches(idx, query, options);
    totalUncapped = matches.length;
    ranges = matches
      .map((m) => rangeFromRaw(idx, m.rawStart, m.rawEnd))
      .filter((r): r is Range => r !== null);
    currentIndex = ranges.length > 0 ? 0 : -1;
    applyHighlights();
    scrollToCurrent();
    notify();
  }

  function setQuery(q: string): void {
    query = q;
    if (q) {
      recompute();
      return;
    }
    ranges = [];
    currentIndex = -1;
    clearHighlights();
    notify();
  }

  function next(): void {
    if (ranges.length === 0) {
      return;
    }
    currentIndex = (currentIndex + 1) % ranges.length;
    refreshCurrent();
    scrollToCurrent();
    notify();
  }

  function prev(): void {
    if (ranges.length === 0) {
      return;
    }
    currentIndex = (currentIndex - 1 + ranges.length) % ranges.length;
    refreshCurrent();
    scrollToCurrent();
    notify();
  }

  function setOptions(opts: Partial<SearchOptions>): void {
    options = { ...options, ...opts };
    index = null;
    if (query) {
      recompute();
    } else {
      notify();
    }
  }

  function reset(): void {
    index = null;
    ranges = [];
    currentIndex = -1;
    clearHighlights();
    if (query) {
      recompute();
    } else {
      notify();
    }
  }

  function clear(): void {
    query = "";
    ui.input.value = "";
    ranges = [];
    currentIndex = -1;
    clearHighlights();
    notify();
  }

  const debouncedSetQuery = debounce((q: string) => setQuery(q), 100);
  ui.input.addEventListener("input", () => {
    debouncedSetQuery(ui.input.value);
  });

  return {
    setQuery,
    next,
    prev,
    setOptions,
    getOptions: () => ({ ...options }),
    reset,
    clear,
    getState,
    refocusCurrent: scrollToCurrent,
  };
}
