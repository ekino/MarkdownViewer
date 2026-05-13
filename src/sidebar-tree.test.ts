import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarTree, type ScanResult, type TreeNode } from "./sidebar-tree";

afterEach(() => {
  document.body.innerHTML = "";
});

function mkTree(root: TreeNode | null, truncated = false): ScanResult {
  return { root, truncated };
}

function mountTree(
  result: ScanResult,
  handlers = {
    onOpenFile: vi.fn(),
    onReveal: vi.fn(),
    onRevealDir: vi.fn(),
  },
): { tree: SidebarTree; container: HTMLDivElement; handlers: typeof handlers } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const tree = new SidebarTree(container, handlers);
  tree.setTree(result);
  return { tree, container, handlers };
}

describe("SidebarTree", () => {
  it('renders "No markdown files" when root is null', () => {
    const { container } = mountTree(mkTree(null));
    expect(container.querySelector(".sidebar-empty")).not.toBeNull();
  });

  it("renders root's children at top level (root dir not shown)", () => {
    const { container } = mountTree(
      mkTree({
        kind: "dir",
        name: "root",
        path: "/r",
        children: [
          { kind: "file", name: "a.md", path: "/r/a.md" },
          { kind: "file", name: "b.md", path: "/r/b.md" },
        ],
      }),
    );
    const rows = container.querySelectorAll(".tree-row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("a.md");
  });

  it("auto-expands the root directory on first scan", () => {
    const { container } = mountTree(
      mkTree({
        kind: "dir",
        name: "root",
        path: "/r",
        children: [
          {
            kind: "dir",
            name: "sub",
            path: "/r/sub",
            children: [{ kind: "file", name: "x.md", path: "/r/sub/x.md" }],
          },
        ],
      }),
    );
    // The sub dir should be visible (auto-expanded root → its children render).
    expect(container.textContent).toContain("sub");
    // Its child file should NOT be visible (sub itself isn't auto-expanded).
    expect(container.textContent).not.toContain("x.md");
  });

  it("toggles directory expansion on click", () => {
    const { container } = mountTree(
      mkTree({
        kind: "dir",
        name: "root",
        path: "/r",
        children: [
          {
            kind: "dir",
            name: "sub",
            path: "/r/sub",
            children: [{ kind: "file", name: "x.md", path: "/r/sub/x.md" }],
          },
        ],
      }),
    );
    const subRow = container.querySelector(
      '.tree-row.dir[data-path="/r/sub"]',
    ) as HTMLDivElement;
    subRow.click();
    expect(container.textContent).toContain("x.md");
    subRow.click();
    expect(container.textContent).not.toContain("x.md");
  });

  it("fires onOpenFile with newTab=false on plain click", () => {
    const { container, handlers } = mountTree(
      mkTree({
        kind: "dir",
        name: "root",
        path: "/r",
        children: [{ kind: "file", name: "a.md", path: "/r/a.md" }],
      }),
    );
    const row = container.querySelector(".tree-row.file") as HTMLDivElement;
    row.click();
    expect(handlers.onOpenFile).toHaveBeenCalledWith("/r/a.md", { newTab: false });
  });

  it("fires onOpenFile with newTab=true on cmd-click", () => {
    const { container, handlers } = mountTree(
      mkTree({
        kind: "dir",
        name: "root",
        path: "/r",
        children: [{ kind: "file", name: "a.md", path: "/r/a.md" }],
      }),
    );
    const row = container.querySelector(".tree-row.file") as HTMLDivElement;
    row.dispatchEvent(
      new MouseEvent("click", { bubbles: true, metaKey: true }),
    );
    expect(handlers.onOpenFile).toHaveBeenCalledWith("/r/a.md", { newTab: true });
  });

  it("marks active file with the .active class", () => {
    const { container, tree } = mountTree(
      mkTree({
        kind: "dir",
        name: "root",
        path: "/r",
        children: [
          { kind: "file", name: "a.md", path: "/r/a.md" },
          { kind: "file", name: "b.md", path: "/r/b.md" },
        ],
      }),
    );
    tree.setActive("/r/b.md");
    const active = container.querySelector(".tree-row.active") as HTMLDivElement;
    expect(active?.dataset.path).toBe("/r/b.md");
  });

  it("preserves expanded state across re-renders via setTree", () => {
    const root: TreeNode = {
      kind: "dir",
      name: "root",
      path: "/r",
      children: [
        {
          kind: "dir",
          name: "sub",
          path: "/r/sub",
          children: [{ kind: "file", name: "x.md", path: "/r/sub/x.md" }],
        },
      ],
    };
    const { container, tree } = mountTree(mkTree(root));
    (container.querySelector('[data-path="/r/sub"]') as HTMLDivElement).click();
    expect(container.textContent).toContain("x.md");
    // New scan with the same tree shape — sub should stay open.
    tree.setTree(mkTree(root), /* autoExpandRoot */ false);
    expect(container.textContent).toContain("x.md");
  });

  it("shows truncated notice when scan was clipped", () => {
    const { container } = mountTree(
      mkTree(
        {
          kind: "dir",
          name: "root",
          path: "/r",
          children: [{ kind: "file", name: "a.md", path: "/r/a.md" }],
        },
        true,
      ),
    );
    expect(container.querySelector(".sidebar-truncated")).not.toBeNull();
  });

  it("clear() empties the container and state", () => {
    const { container, tree } = mountTree(
      mkTree({
        kind: "dir",
        name: "root",
        path: "/r",
        children: [{ kind: "file", name: "a.md", path: "/r/a.md" }],
      }),
    );
    expect(container.children.length).toBeGreaterThan(0);
    tree.clear();
    expect(container.children.length).toBe(0);
  });
});
