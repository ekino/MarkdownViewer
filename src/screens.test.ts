import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "./i18n";
import {
  buildBreadcrumb,
  buildFileList,
  buildFolderView,
  buildHome,
  folderMessage,
  type HomeActions,
  type HomeData,
} from "./screens";
import type { Listing } from "./utils";

function actions(): HomeActions {
  return {
    resume: vi.fn(),
    openFolder: vi.fn(),
    openFile: vi.fn(),
    openExamples: vi.fn(),
    openRecent: vi.fn(),
    clearRecents: vi.fn(),
    returnToFolder: vi.fn(),
    closeFolder: vi.fn(),
    openResumeFolder: vi.fn(),
  };
}

const home = (patch: Partial<HomeData> = {}): HomeData => ({
  firstRun: false,
  kept: null,
  resume: null,
  recents: [],
  ...patch,
});

const listing = (patch: Partial<Listing> = {}): Listing => ({
  status: "ok",
  rawCount: 2,
  entries: [
    { name: "guide", kind: "directory" },
    { name: "a.md", kind: "file" },
  ],
  ...patch,
});

const texts = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((e) => e.textContent?.trim());

beforeEach(() => setLocale("fr"));

describe("buildHome", () => {
  it("explains the app and offers the examples on first run", () => {
    const a = actions();
    const node = buildHome(home({ firstRun: true }), a);
    expect(node.querySelector(".open-intro")).not.toBeNull();
    const examples = Array.from(node.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("exemples")
    );
    examples!.click();
    expect(a.openExamples).toHaveBeenCalled();
    expect(node.querySelector(".resume-card")).toBeNull();
  });

  it("does not offer the examples once the reader has history", () => {
    const node = buildHome(home({ recents: [{ path: "/u/docs", kind: "folder" }] }), actions());
    expect(node.textContent).not.toContain("exemples");
    expect(texts(node, ".recent-name")).toEqual(["docs"]);
  });

  it("shows the kept folder with a way back and a way to close it", () => {
    const a = actions();
    const node = buildHome(home({ kept: { name: "docs", accessible: true } }), a);
    expect(node.querySelector(".kept-banner")?.textContent).toContain("docs");
    const [back, close] = Array.from(node.querySelectorAll<HTMLButtonElement>(".kept-banner button"));
    back.click();
    close.click();
    expect(a.returnToFolder).toHaveBeenCalled();
    expect(a.closeFolder).toHaveBeenCalled();
  });

  it("only offers to close a kept folder that is no longer accessible", () => {
    const node = buildHome(home({ kept: { name: "docs", accessible: false } }), actions());
    expect(node.querySelectorAll(".kept-banner button")).toHaveLength(1);
  });

  it("resumes the last document, or says it is gone", () => {
    const a = actions();
    const ok = buildHome(
      home({ resume: { title: "Guide", file: "a.md", rootName: "docs", status: "ok" }, recents: [] }),
      a
    );
    ok.querySelector<HTMLButtonElement>(".btn-resume")!.click();
    expect(a.resume).toHaveBeenCalled();

    const gone = buildHome(
      home({ resume: { title: "Guide", file: "a.md", rootName: "docs", status: "missing" } }),
      a
    );
    expect(gone.querySelector(".resume-card--missing")?.textContent).toContain("Introuvable");
    expect(gone.querySelector(".btn-resume")).toBeNull();
  });

  it("writes names as text, never as HTML", () => {
    const node = buildHome(
      home({ recents: [{ path: "/u/<img src=x onerror=alert(1)>.md", kind: "file" }] }),
      actions()
    );
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector(".recent-name")?.textContent).toBe("<img src=x onerror=alert(1)>.md");
  });
});

describe("folder view", () => {
  it("tells empty, Markdown-less and unreadable folders apart", () => {
    expect(folderMessage(listing({ rawCount: 0, entries: [] }))).toBe("Ce dossier est vide.");
    expect(folderMessage(listing({ rawCount: 3, entries: [] }))).toBe("Aucun fichier Markdown dans ce dossier.");
    expect(folderMessage(listing({ status: "denied", entries: [] }))).toBe("Markdown Viewer n'a pas accès à ce dossier.");
    expect(folderMessage(listing())).toBeNull();
  });

  it("offers the README only when there is one", () => {
    const open = { open: vi.fn(), openReadme: vi.fn(), openOther: vi.fn() };
    const without = buildFolderView({ rootName: "docs", dir: [], listing: listing(), readme: null }, open);
    expect(without.textContent).not.toContain("README");
    const withReadme = buildFolderView(
      { rootName: "docs", dir: [], listing: listing({ entries: [{ name: "README.md", kind: "file" }] }), readme: "README.md" },
      open
    );
    expect(withReadme.querySelector(".tile--readme")).not.toBeNull();
  });

  it("titles a subfolder by its own name", () => {
    const node = buildFolderView(
      { rootName: "docs", dir: ["guide", "api"], listing: listing(), readme: null },
      { open: vi.fn(), openReadme: vi.fn(), openOther: vi.fn() }
    );
    expect(node.querySelector(".folder-title")?.textContent).toBe("api");
  });
});

describe("buildFileList", () => {
  it("marks the open document and offers a way up in a subfolder", () => {
    const up = vi.fn();
    const list = buildFileList(listing(), true, "a.md", null, { open: vi.fn(), up });
    expect(texts(list, ".file-item .name")).toEqual(["Dossier parent", "guide", "a.md"]);
    expect(list.querySelector('[aria-current="page"] .name')?.textContent).toBe("a.md");
    list.querySelector<HTMLButtonElement>(".file-item--up")!.click();
    expect(up).toHaveBeenCalled();
  });

  it("keeps file names as text", () => {
    const list = buildFileList(
      listing({ entries: [{ name: "<b>guide</b>.md", kind: "file" }] }),
      false,
      null,
      null,
      { open: vi.fn(), up: vi.fn() }
    );
    expect(list.querySelector("b")).toBeNull();
    expect(list.querySelector(".name")?.textContent).toBe("<b>guide</b>.md");
  });
});

describe("buildBreadcrumb", () => {
  it("links every folder and marks the document as the current place", () => {
    const openDir = vi.fn();
    const frag = buildBreadcrumb("docs", ["guide"], "a.md", false, openDir);
    const nav = document.createElement("nav");
    nav.append(frag);
    const crumbs = Array.from(nav.querySelectorAll("button.crumb"));
    expect(crumbs.map((c) => c.textContent)).toEqual(["docs", "guide"]);
    (crumbs[0] as HTMLButtonElement).click();
    expect(openDir).toHaveBeenCalledWith(0);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("a.md");
  });
});
