// In-renderer tab bar.
//
// Tabs hold file paths, not content. When the user activates a tab the
// host calls back into TabManager via `onActivate(filePath)` and the
// existing markdown-load pipeline does the rest. Scroll position is
// stashed per-tab so switching back to a tab restores the previous
// reading position.

let nextTabId = 1;

export interface Tab {
  id: string;
  filePath: string; // absolute path on disk
  title: string; // display name (basename without extension by default)
  scrollY: number;
}

export interface TabManagerHandlers {
  /// Called when a tab becomes active. Implementation should load the
  /// file and restore scroll. Returns the scroll target so the manager
  /// can re-apply it after the content is rendered (the host knows when
  /// the DOM is ready; the manager doesn't).
  onActivate: (filePath: string, scrollY: number) => Promise<void> | void;
  /// Fired after the active tab changes OR a tab is closed. The host
  /// persists session state on this signal.
  onChange: (state: { tabs: Tab[]; activeId: string | null }) => void;
  /// Called when the last tab is closed. The host typically swaps to
  /// the welcome view at this point.
  onEmpty: () => void;
}

export interface TabManagerOptions {
  /// Maximum tabs the manager will keep open. Excess closes silently.
  maxTabs?: number;
}

const DEFAULT_MAX = 16;

function basenameNoExt(p: string): string {
  const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const name = sep >= 0 ? p.slice(sep + 1) : p;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export class TabManager {
  private container: HTMLElement;
  private handlers: TabManagerHandlers;
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  private maxTabs: number;

  constructor(
    container: HTMLElement,
    handlers: TabManagerHandlers,
    opts: TabManagerOptions = {},
  ) {
    this.container = container;
    this.handlers = handlers;
    this.maxTabs = opts.maxTabs ?? DEFAULT_MAX;
  }

  getState(): { tabs: ReadonlyArray<Tab>; activeId: string | null } {
    return { tabs: this.tabs, activeId: this.activeId };
  }

  /// Open `filePath` in a new tab (or activate the existing one) and
  /// make it active. Returns the tab id.
  async openInNewTab(filePath: string): Promise<string> {
    const existing = this.tabs.find((t) => t.filePath === filePath);
    if (existing) {
      await this.activate(existing.id);
      return existing.id;
    }
    if (this.tabs.length >= this.maxTabs) {
      // Bump the oldest non-active tab so the new one fits.
      const victim = this.tabs.find((t) => t.id !== this.activeId);
      if (victim) await this.closeTab(victim.id, { notify: false });
    }
    const tab: Tab = {
      id: `tab-${nextTabId++}`,
      filePath,
      title: basenameNoExt(filePath),
      scrollY: 0,
    };
    this.tabs.push(tab);
    await this.activate(tab.id);
    return tab.id;
  }

  /// Replace the active tab's content with `filePath`. If no tab is
  /// active, opens in a new one.
  async openInActiveTab(filePath: string): Promise<void> {
    if (!this.activeId) {
      await this.openInNewTab(filePath);
      return;
    }
    const existing = this.tabs.find((t) => t.filePath === filePath);
    if (existing) {
      await this.activate(existing.id);
      return;
    }
    const active = this.tabs.find((t) => t.id === this.activeId);
    if (!active) {
      await this.openInNewTab(filePath);
      return;
    }
    active.filePath = filePath;
    active.title = basenameNoExt(filePath);
    active.scrollY = 0;
    this.render();
    await this.handlers.onActivate(filePath, 0);
    this.handlers.onChange(this.snapshot());
  }

  async activate(id: string): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.captureScrollOfActive();
    this.activeId = id;
    this.render();
    const tab = this.tabs[idx];
    await this.handlers.onActivate(tab.filePath, tab.scrollY);
    this.handlers.onChange(this.snapshot());
  }

  async closeTab(
    id: string,
    opts: { notify?: boolean } = { notify: true },
  ): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const wasActive = this.activeId === id;
    this.tabs.splice(idx, 1);
    if (wasActive) {
      // Activate the right neighbour, or the left one if we just closed
      // the rightmost tab.
      const next = this.tabs[idx] ?? this.tabs[idx - 1];
      if (next) {
        this.activeId = next.id;
        this.render();
        await this.handlers.onActivate(next.filePath, next.scrollY);
      } else {
        this.activeId = null;
        this.render();
        this.handlers.onEmpty();
      }
    } else {
      this.render();
    }
    if (opts.notify !== false) this.handlers.onChange(this.snapshot());
  }

  /// Close the currently active tab. Returns whether one was closed.
  async closeActive(): Promise<boolean> {
    if (!this.activeId) return false;
    await this.closeTab(this.activeId);
    return true;
  }

  cycle(delta: number): void {
    if (this.tabs.length === 0) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const base = idx < 0 ? 0 : idx;
    const n = this.tabs.length;
    const next = ((base + delta) % n + n) % n;
    void this.activate(this.tabs[next].id);
  }

  /// Jump to tab N (1-based, matching ⌘1..⌘9).
  jumpTo(n: number): void {
    const idx = n - 1;
    if (idx < 0 || idx >= this.tabs.length) return;
    void this.activate(this.tabs[idx].id);
  }

  /// Cache the current scroll position into the active tab so it's
  /// restored on next activation. Callers (the host's loadFile or a
  /// window scroll listener) invoke this; the manager doesn't poll.
  captureScrollOfActive(scrollY?: number): void {
    if (!this.activeId) return;
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    if (typeof scrollY === "number") {
      tab.scrollY = scrollY;
    }
  }

  /// Replace the entire tab list (used by session restore). Activates
  /// the requested id (or the first tab) without firing onActivate —
  /// the caller is responsible for loading the active file.
  async restore(tabs: Tab[], activeId: string | null): Promise<void> {
    this.tabs = tabs.slice(0, this.maxTabs).map((t) => ({ ...t }));
    this.activeId =
      activeId && this.tabs.some((t) => t.id === activeId)
        ? activeId
        : this.tabs[0]?.id ?? null;
    this.render();
    // We deliberately don't call onActivate here — the host's init
    // sequence wires up the active doc separately so it can sequence
    // theme/search initialization.
  }

  /// Hide the tab bar when no tabs are open (welcome state).
  private updateBarVisibility(): void {
    this.container.hidden = this.tabs.length === 0;
  }

  private render(): void {
    this.updateBarVisibility();
    this.container.replaceChildren();
    for (const tab of this.tabs) {
      const el = document.createElement("button");
      el.className = "tab-pill";
      el.type = "button";
      if (tab.id === this.activeId) el.classList.add("active");
      el.dataset.tabId = tab.id;
      el.title = tab.filePath;

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tab.title;

      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close tab");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.closeTab(tab.id);
      });

      el.append(label, close);
      el.addEventListener("click", () => {
        if (tab.id !== this.activeId) void this.activate(tab.id);
      });
      el.addEventListener("auxclick", (e) => {
        // Middle-click closes the tab — matches browser tab UX.
        if ((e as MouseEvent).button === 1) {
          e.preventDefault();
          void this.closeTab(tab.id);
        }
      });
      this.container.appendChild(el);
    }
  }

  private snapshot(): { tabs: Tab[]; activeId: string | null } {
    return {
      tabs: this.tabs.map((t) => ({ ...t })),
      activeId: this.activeId,
    };
  }
}
