// Recursive markdown-only sidebar tree.
//
// State is split into two pieces:
//   - `tree`: the filtered ScanResult from Rust. Immutable per scan.
//   - `expanded`: a Set<path> of directory paths the user has opened.
// Re-rendering after a watcher event re-fetches the tree but reuses
// the expansion set so nodes the user opened stay open.

export type TreeNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "dir"; name: string; path: string; children: TreeNode[] };

export interface ScanResult {
  root: TreeNode | null;
  truncated: boolean;
}

export interface SidebarTreeHandlers {
  onOpenFile: (path: string, opts: { newTab: boolean }) => void;
  onReveal: (path: string) => void;
  // Right-click on directory: surface the same Reveal action.
  onRevealDir: (path: string) => void;
}

const CHEVRON_DOWN = "▾"; // ▾
const CHEVRON_RIGHT = "▸"; // ▸
const FILE_ICON = "\u{1F4C4}";
const DIR_ICON = "\u{1F4C1}";

export class SidebarTree {
  private container: HTMLElement;
  private handlers: SidebarTreeHandlers;
  private tree: ScanResult = { root: null, truncated: false };
  private expanded: Set<string> = new Set();
  private activePath: string | null = null;

  constructor(container: HTMLElement, handlers: SidebarTreeHandlers) {
    this.container = container;
    this.handlers = handlers;
  }

  setTree(tree: ScanResult, autoExpandRoot = true): void {
    this.tree = tree;
    // First scan: open the root so files at the top level are visible
    // without a click. Subsequent scans (live watcher updates) preserve
    // whatever the user had open.
    if (autoExpandRoot && tree.root?.kind === "dir") {
      this.expanded.add(tree.root.path);
    }
    this.render();
  }

  setActive(filePath: string | null): void {
    this.activePath = filePath;
    this.render();
  }

  clear(): void {
    this.tree = { root: null, truncated: false };
    this.expanded.clear();
    this.activePath = null;
    this.container.replaceChildren();
  }

  private render(): void {
    this.container.replaceChildren();
    if (!this.tree.root) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "No markdown files";
      this.container.appendChild(empty);
      return;
    }
    if (this.tree.root.kind === "dir") {
      // Root is rendered as its children directly (no top-level "root"
      // node) so the sidebar matches user expectations from VS Code.
      for (const child of this.tree.root.children) {
        this.container.appendChild(this.renderNode(child, 0));
      }
    } else {
      this.container.appendChild(this.renderNode(this.tree.root, 0));
    }
    if (this.tree.truncated) {
      const note = document.createElement("div");
      note.className = "sidebar-truncated";
      note.textContent = "(folder too large — list truncated)";
      this.container.appendChild(note);
    }
  }

  private renderNode(node: TreeNode, depth: number): HTMLElement {
    if (node.kind === "file") {
      return this.renderFile(node, depth);
    }
    return this.renderDir(node, depth);
  }

  private renderFile(
    node: TreeNode & { kind: "file" },
    depth: number,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row file";
    row.dataset.path = node.path;
    row.style.paddingLeft = `${depth * 14 + 8}px`;
    if (this.activePath === node.path) {
      row.classList.add("active");
    }
    row.innerHTML = `<span class="chevron"></span><span class="icon">${FILE_ICON}</span><span class="name"></span>`;
    (row.querySelector(".name") as HTMLSpanElement).textContent = node.name;

    row.addEventListener("click", (e) => {
      // Cmd/Ctrl-click → open in a new tab. The tab manager handles the
      // duplicate-path check, so we don't need to dedupe here.
      const newTab = e.metaKey || e.ctrlKey;
      this.handlers.onOpenFile(node.path, { newTab });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.handlers.onReveal(node.path);
    });
    return row;
  }

  private renderDir(
    node: TreeNode & { kind: "dir" },
    depth: number,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "tree-node";

    const row = document.createElement("div");
    row.className = "tree-row dir";
    row.dataset.path = node.path;
    row.style.paddingLeft = `${depth * 14 + 4}px`;

    const isOpen = this.expanded.has(node.path);
    const chevron = isOpen ? CHEVRON_DOWN : CHEVRON_RIGHT;
    row.innerHTML = `<span class="chevron">${chevron}</span><span class="icon">${DIR_ICON}</span><span class="name"></span>`;
    (row.querySelector(".name") as HTMLSpanElement).textContent = node.name;

    row.addEventListener("click", () => {
      if (this.expanded.has(node.path)) {
        this.expanded.delete(node.path);
      } else {
        this.expanded.add(node.path);
      }
      this.render();
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.handlers.onRevealDir(node.path);
    });

    wrap.appendChild(row);

    if (isOpen) {
      const childrenWrap = document.createElement("div");
      childrenWrap.className = "tree-children";
      for (const child of node.children) {
        childrenWrap.appendChild(this.renderNode(child, depth + 1));
      }
      wrap.appendChild(childrenWrap);
    }
    return wrap;
  }
}
