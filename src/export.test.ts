import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAssetRewrites,
  buildStandaloneHtml,
  collectAssets,
  collectInlineCss,
  runExport,
} from "./export";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("buildStandaloneHtml", () => {
  it("wraps body html with inlined styles and an escaped title", () => {
    const html = buildStandaloneHtml(
      "hi <world>",
      "<p>x</p>",
      [".x { color: red; }", "/* dup */"],
    );
    expect(html).toContain("<title>hi &lt;world&gt;</title>");
    expect(html).toContain("<style>.x { color: red; }</style>");
    expect(html).toContain("<style>/* dup */</style>");
    expect(html).toContain("<p>x</p>");
  });

  it("drops empty css blocks", () => {
    const html = buildStandaloneHtml("t", "<p/>", ["", "   "]);
    expect(html).not.toContain("<style>");
  });
});

describe("collectInlineCss", () => {
  it("returns text of every <style> tag, deduped", () => {
    const a = document.createElement("style");
    a.textContent = "body { color: red; }";
    document.head.appendChild(a);
    const b = document.createElement("style");
    b.textContent = "body { color: red; }"; // duplicate
    document.head.appendChild(b);
    const c = document.createElement("style");
    c.textContent = "p { margin: 0; }";
    document.head.appendChild(c);
    const out = collectInlineCss(document);
    // Both unique <style> contents are present; the duplicate appears once.
    const redCount = out.filter((s) => s === "body { color: red; }").length;
    const pCount = out.filter((s) => s === "p { margin: 0; }").length;
    expect(redCount).toBe(1);
    expect(pCount).toBe(1);
  });
});

describe("collectAssets", () => {
  it("pairs each local <img> with a rel name and dedupes by absolute path", () => {
    const root = document.createElement("div");
    const a = document.createElement("img");
    a.setAttribute("src", "asset://localhost/Users/me/docs/img/a.png");
    const b = document.createElement("img");
    b.setAttribute("src", "asset://localhost/Users/me/docs/img/a.png"); // dup
    const c = document.createElement("img");
    c.setAttribute("src", "img/b.png"); // relative
    root.append(a, b, c);

    const { assets, rewrites } = collectAssets(root, "/Users/me/docs");
    const paths = assets.map((x) => x.src).sort();
    expect(paths).toEqual([
      "/Users/me/docs/img/b.png",
      "/Users/me/docs/img/a.png",
    ].sort());
    // both a and b should point to the same rel.
    expect(rewrites.get(a)).toBe(rewrites.get(b));
    expect(rewrites.get(c)).toBeTruthy();
  });

  it("skips remote and data URIs", () => {
    const root = document.createElement("div");
    const a = document.createElement("img");
    a.setAttribute("src", "https://example.com/x.png");
    const b = document.createElement("img");
    b.setAttribute("src", "data:image/png;base64,zzz");
    root.append(a, b);

    const { assets, rewrites } = collectAssets(root, "/docs");
    expect(assets).toHaveLength(0);
    expect(rewrites.size).toBe(0);
  });

  it("resolves http://asset.localhost/ URLs (Tauri 2 form)", () => {
    const root = document.createElement("div");
    const a = document.createElement("img");
    a.setAttribute("src", "http://asset.localhost/Users/me/docs/img/a.png");
    root.append(a);
    const { assets } = collectAssets(root, "/Users/me/docs");
    expect(assets.map((x) => x.src)).toEqual(["/Users/me/docs/img/a.png"]);
  });

  it("disambiguates name collisions across different source dirs", () => {
    const root = document.createElement("div");
    const a = document.createElement("img");
    a.setAttribute("src", "/dir1/logo.png");
    const b = document.createElement("img");
    b.setAttribute("src", "/dir2/logo.png");
    root.append(a, b);

    const { assets } = collectAssets(root, "/anywhere");
    const rels = assets.map((x) => x.rel);
    expect(new Set(rels).size).toBe(2);
  });
});

describe("applyAssetRewrites", () => {
  it("updates each img.src to the assets dir + rel", () => {
    const img = document.createElement("img");
    img.setAttribute("src", "asset://localhost/abs/a.png");
    const rewrites = new Map<HTMLImageElement, string>([[img, "a.png"]]);
    applyAssetRewrites(rewrites, "doc.assets");
    expect(img.getAttribute("src")).toBe("doc.assets/a.png");
  });
});

describe("runExport", () => {
  it("md-copy invokes copy_markdown_source and returns the chosen path", async () => {
    const save = vi.fn().mockResolvedValue("/out/foo.md");
    const invoke = vi.fn().mockResolvedValue(undefined);
    const out = await runExport(
      "md-copy",
      {
        sourcePath: "/src/foo.md",
        rootPath: "/src",
        markdownEl: document.createElement("div"),
        defaultStem: "foo",
      },
      { save, invoke },
    );
    expect(out).toBe("/out/foo.md");
    expect(invoke).toHaveBeenCalledWith("copy_markdown_source", {
      srcPath: "/src/foo.md",
      outputPath: "/out/foo.md",
    });
  });

  it("returns null when the user cancels the save dialog", async () => {
    const save = vi.fn().mockResolvedValue(null);
    const invoke = vi.fn();
    const out = await runExport(
      "html-standalone",
      {
        sourcePath: "/x.md",
        rootPath: null,
        markdownEl: document.createElement("div"),
        defaultStem: "x",
      },
      { save, invoke },
    );
    expect(out).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("html-standalone bundles CSS + body and invokes export_html_standalone", async () => {
    const style = document.createElement("style");
    style.textContent = ".x { color: blue; }";
    document.head.appendChild(style);
    const body = document.createElement("div");
    body.innerHTML = "<p>hello</p>";

    const save = vi.fn().mockResolvedValue("/out/x.html");
    const invoke = vi.fn().mockResolvedValue(undefined);
    await runExport(
      "html-standalone",
      {
        sourcePath: "/src/x.md",
        rootPath: "/src",
        markdownEl: body,
        defaultStem: "x",
      },
      { save, invoke },
    );
    const call = invoke.mock.calls.find((c) => c[0] === "export_html_standalone");
    expect(call).toBeDefined();
    const html = (call![1] as { html: string }).html;
    expect(html).toContain("<p>hello</p>");
    expect(html).toContain(".x { color: blue; }");
  });

  it("html-with-assets forwards assets + allowed_roots", async () => {
    const body = document.createElement("div");
    const img = document.createElement("img");
    img.setAttribute("src", "/src/img/a.png");
    body.appendChild(img);
    const save = vi.fn().mockResolvedValue("/out/x.html");
    const invoke = vi.fn().mockResolvedValue(undefined);
    await runExport(
      "html-with-assets",
      {
        sourcePath: "/src/x.md",
        rootPath: "/src",
        markdownEl: body,
        defaultStem: "x",
      },
      { save, invoke },
    );
    const call = invoke.mock.calls.find((c) => c[0] === "export_html_with_assets");
    expect(call).toBeDefined();
    const args = call![1] as {
      assets: Array<{ src: string; rel: string }>;
      allowedRoots: string[];
    };
    expect(args.assets[0].src).toBe("/src/img/a.png");
    expect(args.allowedRoots).toContain("/src");
  });
});
