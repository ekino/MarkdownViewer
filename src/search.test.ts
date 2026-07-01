import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildIndex,
  createSearchController,
  findMatches,
  normalizeQuery,
  normalizeWithMap,
  type SearchOptions,
} from "./search";

const DEFAULT_OPTS: SearchOptions = {
  caseSensitive: false,
  ignoreDiacritics: true,
  wholeWord: false,
};

function makeContainer(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

function makeUI() {
  const input = document.createElement("input");
  const counter = document.createElement("span");
  return { input, counter };
}

describe("normalizeWithMap", () => {
  it("strips diacritics and lowercases when enabled", () => {
    const { normText, offsetMap } = normalizeWithMap("Café", DEFAULT_OPTS);
    expect(normText).toBe("cafe");
    expect(offsetMap.length).toBe("cafe".length + 1);
    expect(offsetMap[0]).toBe(0);
    expect(offsetMap[3]).toBe(3);
  });

  it("preserves case when caseSensitive", () => {
    const { normText } = normalizeWithMap("Café", {
      ...DEFAULT_OPTS,
      caseSensitive: true,
    });
    expect(normText).toBe("Cafe");
  });

  it("keeps diacritics when ignoreDiacritics is false", () => {
    const { normText } = normalizeWithMap("Café", {
      ...DEFAULT_OPTS,
      ignoreDiacritics: false,
    });
    expect(normText).toBe("café");
  });
});

describe("findMatches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds matches ignoring accents and case", () => {
    const c = makeContainer("<p>Le café au lait. CAFÉ encore.</p>");
    const idx = buildIndex(c, DEFAULT_OPTS);
    const hits = findMatches(idx, "cafe", DEFAULT_OPTS);
    expect(hits).toHaveLength(2);
  });

  it("respects caseSensitive option", () => {
    const c = makeContainer("<p>Foo and foo.</p>");
    const opts = { ...DEFAULT_OPTS, caseSensitive: true };
    const idx = buildIndex(c, opts);
    const hits = findMatches(idx, "Foo", opts);
    expect(hits).toHaveLength(1);
  });

  it("respects ignoreDiacritics=false", () => {
    const c = makeContainer("<p>cafe and café</p>");
    const opts = { ...DEFAULT_OPTS, ignoreDiacritics: false };
    const idx = buildIndex(c, opts);
    const hits = findMatches(idx, "café", opts);
    expect(hits).toHaveLength(1);
  });

  it("respects wholeWord option", () => {
    const c = makeContainer("<p>cathedral and the cat sat on category</p>");
    const opts = { ...DEFAULT_OPTS, wholeWord: true };
    const idx = buildIndex(c, opts);
    const hits = findMatches(idx, "cat", opts);
    expect(hits).toHaveLength(1);
  });

  it("matches across element boundaries", () => {
    const c = makeContainer("<p>hel<strong>lo</strong> world</p>");
    const idx = buildIndex(c, DEFAULT_OPTS);
    const hits = findMatches(idx, "hello", DEFAULT_OPTS);
    expect(hits).toHaveLength(1);
  });

  it("excludes nodes inside .katex / .mermaid-wrapper / script / style", () => {
    const c = makeContainer(
      [
        "<p>visible match</p>",
        '<div class="katex">match inside katex</div>',
        '<div class="mermaid-wrapper">match inside mermaid</div>',
        "<script>match inside script</script>",
        "<style>match inside style</style>",
      ].join("")
    );
    const idx = buildIndex(c, DEFAULT_OPTS);
    const hits = findMatches(idx, "match", DEFAULT_OPTS);
    expect(hits).toHaveLength(1);
  });

  it("returns empty for empty query", () => {
    const c = makeContainer("<p>anything</p>");
    const idx = buildIndex(c, DEFAULT_OPTS);
    expect(findMatches(idx, "", DEFAULT_OPTS)).toHaveLength(0);
  });

  it("caps results at MAX_HITS (1000)", () => {
    const c = makeContainer(`<p>${"x ".repeat(2000)}</p>`);
    const idx = buildIndex(c, DEFAULT_OPTS);
    const hits = findMatches(idx, "x", DEFAULT_OPTS);
    expect(hits).toHaveLength(1000);
  });

  it("matches text adjacent to an excluded node without leaking into it", () => {
    const c = makeContainer(
      [
        '<p>before <span class="katex">match-inside</span> after-match</p>',
      ].join("")
    );
    const idx = buildIndex(c, DEFAULT_OPTS);
    const hits = findMatches(idx, "match", DEFAULT_OPTS);
    expect(hits).toHaveLength(1);
  });
});

describe("normalizeQuery", () => {
  it("matches normalization of input text", () => {
    expect(normalizeQuery("CAFÉ", DEFAULT_OPTS)).toBe("cafe");
    expect(normalizeQuery("Élève", DEFAULT_OPTS)).toBe("eleve");
  });
});

describe("createSearchController", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reports total count and current index", () => {
    const c = makeContainer("<p>foo foo foo</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("foo");
    const state = ctrl.getState();
    expect(state.total).toBe(3);
    expect(state.current).toBe(0);
    expect(ui.counter.textContent).toBe("1/3");
  });

  it("navigates next/prev with wrap-around", () => {
    const c = makeContainer("<p>x x x</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("x");
    expect(ctrl.getState().current).toBe(0);
    ctrl.next();
    expect(ctrl.getState().current).toBe(1);
    ctrl.next();
    expect(ctrl.getState().current).toBe(2);
    ctrl.next();
    expect(ctrl.getState().current).toBe(0);
    ctrl.prev();
    expect(ctrl.getState().current).toBe(2);
  });

  it("handles no match gracefully", () => {
    const c = makeContainer("<p>hello</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("xyz");
    expect(ctrl.getState().total).toBe(0);
    expect(ctrl.getState().current).toBe(-1);
    expect(ui.counter.textContent).toBe("0/0");
    ctrl.next();
    expect(ctrl.getState().current).toBe(-1);
  });

  it("clears highlights and counter on empty query", () => {
    const c = makeContainer("<p>foo</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("foo");
    expect(ui.counter.textContent).toBe("1/1");
    ctrl.setQuery("");
    expect(ui.counter.textContent).toBe("");
    expect(ctrl.getState().total).toBe(0);
  });

  it("re-evaluates after reset following DOM mutation", () => {
    const c = makeContainer("<p>foo</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("foo");
    expect(ctrl.getState().total).toBe(1);
    c.innerHTML = "<p>foo bar foo</p>";
    ctrl.reset();
    expect(ctrl.getState().total).toBe(2);
  });

  it("recomputes when options change", () => {
    const c = makeContainer("<p>cafe café</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("café");
    expect(ctrl.getState().total).toBe(2);
    ctrl.setOptions({ ignoreDiacritics: false });
    expect(ctrl.getState().total).toBe(1);
  });

  it("clear() empties input and state", () => {
    const c = makeContainer("<p>foo</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("foo");
    ctrl.clear();
    expect(ui.input.value).toBe("");
    expect(ctrl.getState().total).toBe(0);
  });

  it("clear() cancels a pending debounced query so highlights stay cleared", () => {
    vi.useFakeTimers();
    try {
      const c = makeContainer("<p>foo foo</p>");
      const ui = makeUI();
      const ctrl = createSearchController(c, ui);

      // Simulate the user typing, which schedules a debounced search.
      ui.input.value = "foo";
      ui.input.dispatchEvent(new Event("input"));

      // User clears/dismisses before the debounce fires.
      ctrl.clear();
      expect(ctrl.getState().total).toBe(0);

      // The stale debounce must not re-apply highlights.
      vi.advanceTimersByTime(200);
      expect(ctrl.getState().total).toBe(0);
      expect(c.querySelectorAll("mark.mdv-search-hit")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears highlights when the native search clear button empties the field", () => {
    // WebKit's ✕ button on <input type="search"> fires only a "search" event
    // (no "input"), so the controller must honor it.
    const c = makeContainer("<p>foo foo</p>");
    const ui = makeUI();
    const ctrl = createSearchController(c, ui);
    ctrl.setQuery("foo");
    expect(ctrl.getState().total).toBe(2);
    expect(c.querySelectorAll("mark.mdv-search-hit").length).toBeGreaterThan(0);

    ui.input.value = "";
    ui.input.dispatchEvent(new Event("search"));

    expect(ctrl.getState().total).toBe(0);
    expect(c.querySelectorAll("mark.mdv-search-hit")).toHaveLength(0);
  });
});

// The production app runs in WKWebView, which supports the CSS Custom Highlight
// API (`supportsCSSHighlights === true`) — a different code path from the jsdom
// <mark> fallback exercised above. Polyfill the API and re-import the module so
// the real path is covered.
describe("createSearchController (CSS Custom Highlight API path)", () => {
  class FakeHighlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }

  async function loadWithCSSHighlights() {
    const reg = new Map<string, unknown>();
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    (globalThis as unknown as { CSS: unknown }).CSS = { highlights: reg };
    vi.resetModules();
    const mod = await import("./search");
    return { reg, createSearchController: mod.createSearchController };
  }

  afterEach(() => {
    vi.resetModules();
    delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
    delete (globalThis as unknown as { CSS?: unknown }).CSS;
    document.body.innerHTML = "";
  });

  it("removes highlights from the registry when the search clear button fires", async () => {
    const { reg, createSearchController: create } = await loadWithCSSHighlights();
    const c = makeContainer("<p>foo foo foo</p>");
    const ui = makeUI();
    const ctrl = create(c, ui);

    ctrl.setQuery("foo");
    expect(reg.size).toBeGreaterThan(0);

    // Native ✕ button: field emptied, only a "search" event fires.
    ui.input.value = "";
    ui.input.dispatchEvent(new Event("search"));

    expect(reg.size).toBe(0);
    expect(ctrl.getState().total).toBe(0);
  });
});
